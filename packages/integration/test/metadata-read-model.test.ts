import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionRecord } from "../../contracts/src/index.js";
import { MetadataStore } from "../../storage/src/metadata.js";
import { CompanionHttpServer } from "../src/companion-http.js";
import { CompanionPolicy } from "../src/companion-policy.js";
import { HostEnrollmentRegistry } from "../src/host-enrollment.js";
import { createMetadataReadModel } from "../src/metadata-read-model.js";

function session(sessionId: string, hostId: string): SessionRecord {
  return {
    sessionId, hostId, hostBootEpoch: "epoch-1", kind: "local-pty", transport: "connected", process: "running",
    recovery: "none", createdAt: "2026-11-17T00:00:00.000Z", lastObservedAt: "2026-11-17T00:00:01.000Z", pid: 4242, exitCode: null,
  };
}

test("metadata read model scopes to the host and drops non-contract fields", () => {
  const model = createMetadataReadModel({ listSessions: () => [session("a", "host-1"), session("b", "host-2")] });
  assert.deepEqual(model.listSessions("host-1"), [{ sessionId: "a", kind: "local-pty", process: "running", transport: "connected" }]);
  assert.deepEqual(model.listSessions("host-3"), []);
});

test("a grant for one host cannot read another host's sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-rm-"));
  const store = new MetadataStore(path.join(dir, "m.sqlite"));
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-1", "Host One", "2026-11-17T00:00:00.000Z");
  enrollment.enroll("host-2", "Host Two", "2026-11-17T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000), { readModel: createMetadataReadModel(store) });
  try {
    store.saveSession(session("other-host", "host-2"));
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;
    const auth = await fetch(`${base}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "c1", enrollmentToken: issued.enrollmentToken, capability: "read-workspace" }),
    });
    const { grant } = await auth.json() as { grant: { grantId: string } };
    const res = await fetch(`${base}/v1/companion/hosts/host-2/sessions`, {
      headers: { authorization: `Bearer ${grant.grantId}`, "x-nexus-client-id": "c1" },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.text()).includes("other-host"), false);
  } finally {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after reconcile, sessions from a previous boot epoch read as unknown/disconnected", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-rm-"));
  const store = new MetadataStore(path.join(dir, "m.sqlite"));
  try {
    store.saveSession(session("stale", "host-1"));
    store.reconcileSupervisorRestart("epoch-2");
    assert.deepEqual(createMetadataReadModel(store).listSessions("host-1"),
      [{ sessionId: "stale", kind: "local-pty", process: "unknown", transport: "disconnected" }]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("companion endpoint serves persisted sessions from SQLite without PID or epoch", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-rm-"));
  const store = new MetadataStore(path.join(dir, "m.sqlite"));
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-1", "Host One", "2026-11-17T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000), { readModel: createMetadataReadModel(store) });
  try {
    store.saveSession(session("persisted-1", "host-1"));
    store.saveSession(session("other-host", "host-2"));
    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;
    const auth = await fetch(`${base}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "c1", enrollmentToken: issued.enrollmentToken, capability: "read-workspace" }),
    });
    const { grant } = await auth.json() as { grant: { grantId: string } };
    const res = await fetch(`${base}/v1/companion/hosts/host-1/sessions`, {
      headers: { authorization: `Bearer ${grant.grantId}`, "x-nexus-client-id": "c1" },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { sessions: [{ sessionId: "persisted-1", kind: "local-pty", process: "running", transport: "connected" }] });
    assert.equal(text.includes("4242"), false);
    assert.equal(text.includes("epoch-1"), false);
  } finally {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
