import assert from "node:assert/strict";
import test from "node:test";
import { CompanionHttpServer } from "../src/companion-http.js";
import { CompanionPolicy } from "../src/companion-policy.js";
import { HostEnrollmentRegistry } from "../src/host-enrollment.js";

test("loopback companion HTTP authorizes bounded read access without exposing the token", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000));
  const address = await server.start();
  try {
    const health = await fetch(`http://${address.host}:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, mode: "loopback" });
    const response = await fetch(`http://${address.host}:${address.port}/v1/companion/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: issued.host.hostId, clientId: "browser-client", enrollmentToken: issued.enrollmentToken, capability: "attach-read" }),
    });
    const body = await response.json() as { accepted: boolean; grant?: { capability: string }; enrollmentToken?: string };
    assert.equal(response.status, 200);
    assert.equal(body.accepted, true);
    assert.equal(body.grant?.capability, "attach-read");
    assert.equal("enrollmentToken" in body, false);
  } finally {
    await server.stop();
  }
});

test("companion grant reads session metadata without exposing terminal access", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000), {
    readModel: { listSessions: () => [{ sessionId: "session-1", kind: "local-pty", process: "running", transport: "connected", output: "secret-output", credentials: "secret" } as never] },
  });
  const address = await server.start();
  try {
    const authorized = await fetch(`http://${address.host}:${address.port}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: issued.host.hostId, clientId: "browser-client", enrollmentToken: issued.enrollmentToken, capability: "read-workspace" }),
    });
    const authorization = await authorized.json() as { grant: { grantId: string } };
    const sessions = await fetch(`http://${address.host}:${address.port}/v1/companion/hosts/${issued.host.hostId}/sessions`, {
      headers: { authorization: `Bearer ${authorization.grant.grantId}`, "x-nexus-client-id": "browser-client" },
    });
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), { sessions: [{ sessionId: "session-1", kind: "local-pty", process: "running", transport: "connected" }] });
    const malformed = await fetch(`http://${address.host}:${address.port}/v1/companion/hosts/%ZZ/sessions`, {
      headers: { authorization: `Bearer ${authorization.grant.grantId}`, "x-nexus-client-id": "browser-client" },
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.stop();
  }
});

test("revoking a host invalidates its existing companion grant", () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const policy = new CompanionPolicy(enrollment, 60_000);
  const result = policy.authorize({ hostId: issued.host.hostId, clientId: "client", enrollmentToken: issued.enrollmentToken, network: "private", capability: "read-workspace" }, "2026-11-16T01:00:00.000Z");
  assert.equal(result.accepted, true);
  if (result.accepted) {
    enrollment.revoke(issued.host.hostId, "2026-11-16T01:00:01.000Z");
    assert.equal(policy.validateGrant(result.grant.grantId, issued.host.hostId, "client", "read-workspace", "2026-11-16T01:00:02.000Z"), false);
  }
});

test("companion HTTP rejects untyped write or exec requests", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment));
  const address = await server.start();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1/companion/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: issued.host.hostId, clientId: "browser-client", enrollmentToken: issued.enrollmentToken, capability: "exec" }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { accepted: false, reason: "invalid-request" });
  } finally {
    await server.stop();
  }
});

test("companion HTTP rate-limits repeated invalid authentication attempts", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-xenos", "Windows Xenos", "2026-11-16T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment));
  const address = await server.start();
  try {
    const request = (): Promise<Response> => fetch(`http://${address.host}:${address.port}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: issued.host.hostId, clientId: "browser-client", enrollmentToken: "wrong-token", capability: "attach-read" }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await request()).status, 401);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate-limited" });
  } finally {
    await server.stop();
  }
});
