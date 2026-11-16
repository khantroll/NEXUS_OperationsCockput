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
