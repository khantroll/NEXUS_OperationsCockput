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

test("attach-read grants read bounded terminal output; other capabilities and hosts cannot", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const one = enrollment.enroll("host-1", "Host One", "2026-11-17T00:00:00.000Z");
  enrollment.enroll("host-2", "Host Two", "2026-11-17T00:00:00.000Z");
  const outputs = new Map([["s1", "hello\r\n"], ["big", "x".repeat(100_000)]]);
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000), {
    readModel: { listSessions: () => [] },
    outputSource: { readOutput: (hostId, sessionId) => hostId === "host-1" ? outputs.get(sessionId) ?? null : null },
  });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;
  const grantFor = async (capability: string): Promise<string> => {
    const res = await fetch(`${base}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "c1", enrollmentToken: one.enrollmentToken, capability }),
    });
    return ((await res.json()) as { grant: { grantId: string } }).grant.grantId;
  };
  const get = (url: string, grant: string): Promise<Response> => fetch(`${base}${url}`, { headers: { authorization: `Bearer ${grant}`, "x-nexus-client-id": "c1" } });
  try {
    const attach = await grantFor("attach-read");
    const ok = await get("/v1/companion/hosts/host-1/sessions/s1/output", attach);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { sessionId: "s1", truncated: false, output: "hello\r\n" });
    const big = await (await get("/v1/companion/hosts/host-1/sessions/big/output", attach)).json() as { truncated: boolean; output: string };
    assert.equal(big.truncated, true);
    assert.equal(big.output.length, 64 * 1024);
    assert.equal((await get("/v1/companion/hosts/host-1/sessions/nope/output", attach)).status, 404);
    assert.equal((await get("/v1/companion/hosts/host-1/sessions/bad%20id/output", attach)).status, 400);
    // A read-workspace grant is not enough to read terminal output.
    assert.equal((await get("/v1/companion/hosts/host-1/sessions/s1/output", await grantFor("read-workspace"))).status, 401);
    // A host-1 grant cannot read host-2, and unknown/absent credentials fail.
    assert.equal((await get("/v1/companion/hosts/host-2/sessions/s1/output", attach)).status, 401);
    assert.equal((await get("/v1/companion/hosts/host-1/sessions/s1/output", "forged")).status, 401);
    assert.equal((await fetch(`${base}/v1/companion/hosts/host-1/sessions/s1/output`)).status, 401);
    // The attach-read grant cannot list sessions (different capability) and there is no write route.
    assert.equal((await get("/v1/companion/hosts/host-1/sessions", attach)).status, 401);
    const post = await fetch(`${base}/v1/companion/hosts/host-1/sessions/s1/output`, { method: "POST", headers: { authorization: `Bearer ${attach}`, "x-nexus-client-id": "c1" }, body: "rm -rf /" });
    assert.equal(post.status, 404);
  } finally {
    await server.stop();
  }
});

test("terminal output endpoint is disabled unless an output source is configured", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-1", "Host One", "2026-11-17T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000));
  const address = await server.start();
  try {
    const auth = await fetch(`http://${address.host}:${address.port}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "c1", enrollmentToken: issued.enrollmentToken, capability: "attach-read" }),
    });
    const { grant } = await auth.json() as { grant: { grantId: string } };
    const res = await fetch(`http://${address.host}:${address.port}/v1/companion/hosts/host-1/sessions/s1/output`, { headers: { authorization: `Bearer ${grant.grantId}`, "x-nexus-client-id": "c1" } });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
});

test("oversized multi-byte output is cut on a character boundary", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-1", "Host One", "2026-11-17T00:00:00.000Z");
  const text = "é".repeat(50_000); // 100,000 bytes of 2-byte characters
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment, 60_000), { outputSource: { readOutput: () => text } });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;
  try {
    const auth = await fetch(`${base}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "c1", enrollmentToken: issued.enrollmentToken, capability: "attach-read" }),
    });
    const { grant } = await auth.json() as { grant: { grantId: string } };
    const res = await fetch(`${base}/v1/companion/hosts/host-1/sessions/s1/output`, { headers: { authorization: `Bearer ${grant.grantId}`, "x-nexus-client-id": "c1" } });
    const body = await res.json() as { truncated: boolean; output: string };
    assert.equal(body.truncated, true);
    assert.equal(body.output.includes("�"), false);
    assert.ok(Buffer.byteLength(body.output, "utf8") <= 64 * 1024);
    assert.match(body.output, /^é+$/);
  } finally {
    await server.stop();
  }
});
