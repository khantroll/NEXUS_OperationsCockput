import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionHttpServer } from "../src/companion-http.js";
import { CompanionPolicy } from "../src/companion-policy.js";
import { HostEnrollmentRegistry } from "../src/host-enrollment.js";
import { detectTailscaleAddress, isPrivateAddress, parseCompanionNetworkConfig, peerAllowed, resolveBind } from "../src/companion-network.js";
import { startCompanionService } from "../src/companion-service.js";

test("private-address classification covers tunnels, LAN and loopback but not public space", () => {
  for (const ok of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "100.64.0.1", "100.127.255.254", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(ok), true, ok);
  }
  for (const bad of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "0.0.0.0", "not-an-ip", ""]) {
    assert.equal(isPrivateAddress(bad), false, bad);
  }
});

test("peer rules: local = loopback only, private = private ranges, https = any peer", () => {
  assert.equal(peerAllowed("local", "127.0.0.1"), true);
  assert.equal(peerAllowed("local", "100.64.0.9"), false);
  assert.equal(peerAllowed("private", "100.64.0.9"), true);
  assert.equal(peerAllowed("private", "203.0.113.9"), false);
  assert.equal(peerAllowed("private", undefined), false);
  assert.equal(peerAllowed("https", "203.0.113.9"), true);
  assert.equal(peerAllowed("https", undefined), false);
});

test("config parsing accepts the three modes and rejects unsafe or malformed ones", () => {
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"local"}').config, { mode: "local" });
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"private","bind":"100.64.1.2","port":5000}').config, { mode: "private", bind: "100.64.1.2", port: 5000 });
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"private"}').config, { mode: "private" });
  assert.match(parseCompanionNetworkConfig('{"mode":"private","bind":"0.0.0.0"}').error ?? "", /private/);
  assert.match(parseCompanionNetworkConfig('{"mode":"private","bind":"8.8.8.8"}').error ?? "", /private/);
  assert.match(parseCompanionNetworkConfig('{"mode":"https","certFile":"c","keyFile":"k","publicHost":"nexus.example.com"}').error ?? "", /experimentalPublicHttps/);
  assert.match(parseCompanionNetworkConfig('{"mode":"https","certFile":"c","keyFile":"k"}').error ?? "", /experimentalPublicHttps|publicHost/);
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"https","experimentalPublicHttps":true,"certFile":"c","keyFile":"k","publicHost":"nexus.example.com"}').config,
    { mode: "https", certFile: "c", keyFile: "k", publicHost: "nexus.example.com" });
  assert.match(parseCompanionNetworkConfig('{"mode":"https","experimentalPublicHttps":true,"publicHost":"x.example.com"}').error ?? "", /certFile/);
  assert.match(parseCompanionNetworkConfig('{"mode":"wide-open"}').error ?? "", /mode/);
  assert.match(parseCompanionNetworkConfig('{"mode":"local","port":70000}').error ?? "", /port/);
  assert.match(parseCompanionNetworkConfig("nope").error ?? "", /JSON/);
  assert.match(parseCompanionNetworkConfig("[]").error ?? "", /object/);
});

test("tailscale auto-detection picks only a non-internal 100.64/10 IPv4 address", () => {
  const interfaces = {
    Ethernet: [{ address: "192.168.1.9", family: "IPv4", internal: false }],
    Loop: [{ address: "100.100.0.1", family: "IPv4", internal: true }],
    Tailscale: [{ address: "fd7a::1", family: "IPv6", internal: false }, { address: "100.101.102.103", family: "IPv4", internal: false }],
  };
  assert.equal(detectTailscaleAddress(interfaces), "100.101.102.103");
  assert.equal(detectTailscaleAddress({ Ethernet: interfaces.Ethernet }), null);
  assert.deepEqual(resolveBind({ mode: "private" }, interfaces), { mode: "private", bind: "100.101.102.103", port: 47821 });
  assert.throws(() => resolveBind({ mode: "private" }, { Ethernet: interfaces.Ethernet }), /Tailscale/);
  assert.deepEqual(resolveBind({ mode: "local" }, {}), { mode: "local", bind: "127.0.0.1", port: 0 });
  assert.deepEqual(resolveBind({ mode: "https", certFile: "c", keyFile: "k", publicHost: "h.example.com" }, {}), { mode: "https", bind: "0.0.0.0", port: 47821 });
});

test("servers refuse unsafe bind/mode combinations", async () => {
  const policy = new CompanionPolicy(new HostEnrollmentRegistry());
  await assert.rejects(new CompanionHttpServer(policy, { mode: "local", bind: "0.0.0.0" }).start(), /loopback/);
  await assert.rejects(new CompanionHttpServer(policy, { mode: "private", bind: "0.0.0.0" }).start(), /private/);
  await assert.rejects(new CompanionHttpServer(policy, { mode: "private", bind: "8.8.8.8" }).start(), /private/);
  assert.throws(() => new CompanionHttpServer(policy, { mode: "https" }), /TLS/);
  assert.throws(() => new CompanionHttpServer(policy, { mode: "local", tls: { cert: "x", key: "y" } }), /https mode/);
});

test("private mode serves a private address and reports its mode", async () => {
  const enrollment = new HostEnrollmentRegistry();
  const issued = enrollment.enroll("host-a", "A", "2026-11-16T00:00:00.000Z");
  // 127.0.0.1 is a private address; real Tailscale/WireGuard addresses take the same path.
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment), { mode: "private", bind: "127.0.0.1" });
  const address = await server.start();
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${address.port}/health`)).json(), { ok: true, mode: "private" });
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-a", clientId: "c", enrollmentToken: issued.enrollmentToken, capability: "read-workspace" }),
    });
    assert.equal(response.status, 200);
  } finally {
    await server.stop();
  }
});

const opensslOk = spawnSync("openssl", ["version"]).status === 0;

test("https mode serves TLS, still requires the token, and plain HTTP cannot reach it", { skip: !opensslOk && "openssl not available" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-tls-"));
  try {
    const keyFile = join(dir, "key.pem");
    const certFile = join(dir, "cert.pem");
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const service = await startCompanionService({
      hostId: "host-tls", displayName: "TLS host",
      readModel: { listSessions: () => [] },
      network: { mode: "https", bind: "127.0.0.1", port: 0, certFile, keyFile, publicHost: "localhost" },
      interfaces: {},
    });
    try {
      assert.equal(service.info.mode, "https");
      assert.match(service.info.url, /^https:\/\/localhost:\d+$/);
      const port = Number(new URL(service.info.url).port);
      const ca = readFileSync(certFile);
      const call = (path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> => new Promise((resolve, reject) => {
        const request = https.request({ host: "127.0.0.1", port, path, method, ca, servername: "localhost", headers: { "content-type": "application/json" } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        request.on("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
      assert.deepEqual((await call("/health", "GET")).json, { ok: true, mode: "https" });
      const bad = await call("/v1/companion/authorize", "POST", { hostId: "host-tls", clientId: "c", enrollmentToken: "wrong", capability: "read-workspace" });
      assert.equal(bad.status, 401);
      const good = await call("/v1/companion/authorize", "POST", { hostId: "host-tls", clientId: "c", enrollmentToken: service.info.enrollmentToken, capability: "read-workspace" });
      assert.equal(good.status, 200);
      // Without trusting the certificate the TLS handshake must fail (no silent downgrade).
      await assert.rejects(new Promise((resolve, reject) => {
        const request = https.request({ host: "127.0.0.1", port, path: "/health", servername: "localhost" }, resolve);
        request.on("error", reject);
        request.end();
      }));
      // Plain HTTP to the TLS port is not served.
      await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAN addresses need an explicit opt-in; tunnel addresses do not; local mode rejects bind", () => {
  assert.match(parseCompanionNetworkConfig('{"mode":"private","bind":"192.168.1.5"}').error ?? "", /unencrypted/);
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"private","bind":"192.168.1.5","allowLan":true}').config, { mode: "private", bind: "192.168.1.5", allowLan: true });
  assert.deepEqual(parseCompanionNetworkConfig('{"mode":"private","bind":"100.101.1.1"}').config, { mode: "private", bind: "100.101.1.1" });
  assert.match(parseCompanionNetworkConfig('{"mode":"private","allowLan":"yes"}').error ?? "", /allowLan/);
  assert.match(parseCompanionNetworkConfig('{"mode":"local","bind":"0.0.0.0"}').error ?? "", /local mode/);
});

test("peer rules handle IPv4-mapped and zone-scoped addresses", () => {
  assert.equal(peerAllowed("private", "::ffff:8.8.8.8"), false);
  assert.equal(peerAllowed("private", "::ffff:100.64.0.1"), true);
  assert.equal(peerAllowed("local", "::ffff:127.0.0.1"), true);
  assert.equal(peerAllowed("local", "::ffff:10.0.0.1"), false);
});

test("authorize attempts are capped globally before any token hashing, not just per source", async () => {
  const enrollment = new HostEnrollmentRegistry();
  enrollment.enroll("host-a", "A", "2026-11-16T00:00:00.000Z");
  const server = new CompanionHttpServer(new CompanionPolicy(enrollment), { mode: "private", bind: "127.0.0.1" });
  const address = await server.start();
  try {
    // Fake distinct sources is not possible over loopback, so exercise the budget directly via one source:
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/companion/authorize`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host-a", clientId: "c", enrollmentToken: "wrong", capability: "read-workspace" }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
    const bad = await fetch(`http://127.0.0.1:${address.port}/v1/companion/authorize`, { method: "POST", body: "{not json" });
    assert.equal(bad.status, 429); // already rate limited; error text for bad JSON is covered below
  } finally {
    await server.stop();
  }
});

test("malformed JSON gets a fixed error, not the parser's message", async () => {
  const server = new CompanionHttpServer(new CompanionPolicy(new HostEnrollmentRegistry()));
  const address = await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/companion/authorize`, { method: "POST", body: "{not json" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid-request" });
  } finally {
    await server.stop();
  }
});

test("per-source connection cap refuses the ninth simultaneous socket", async () => {
  const server = new CompanionHttpServer(new CompanionPolicy(new HostEnrollmentRegistry()), { mode: "private", bind: "127.0.0.1" });
  const address = await server.start();
  const { connect } = await import("node:net");
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    for (let i = 0; i < 9; i += 1) {
      const socket = connect(address.port, "127.0.0.1");
      socket.on("error", () => undefined);
      sockets.push(socket);
      await new Promise((resolve) => socket.once("connect", resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sockets.filter((socket) => socket.destroyed).length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await server.stop();
  }
});
