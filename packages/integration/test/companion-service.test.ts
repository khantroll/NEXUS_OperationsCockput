import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const icacls = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "icacls.exe");
import test from "node:test";
import { aclIsOnly, startCompanionService } from "../src/companion-service.js";

const readModel = { listSessions: () => [{ sessionId: "s1", kind: "local-pty", process: "running", transport: "connected" }] as const };

test("companion service issues a usable token and a user-only credentials file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-svc-"));
  const file = path.join(dir, "nested", "companion.json");
  const service = await startCompanionService({ hostId: "host-1", displayName: "Host One", readModel, credentialsPath: file });
  try {
    assert.equal(service.info.credentialsPath, file);
    assert.equal(service.info.credentialsWarning, null);
    assert.match(service.info.url, /^http:\/\/(127\.0\.0\.1|\[?::1\]?):\d+$/);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { enrollmentToken: string; url: string; hostId: string };
    assert.equal(saved.enrollmentToken, service.info.enrollmentToken);
    const auth = await fetch(`${service.info.url}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: saved.hostId, clientId: "me", enrollmentToken: saved.enrollmentToken, capability: "read-workspace" }),
    });
    const { grant } = await auth.json() as { grant: { grantId: string } };
    const res = await fetch(`${service.info.url}/v1/companion/hosts/host-1/sessions`, {
      headers: { authorization: `Bearer ${grant.grantId}`, "x-nexus-client-id": "me" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sessions: [{ sessionId: "s1", kind: "local-pty", process: "running", transport: "connected" }] });
    if (process.platform === "win32") {
      const acl = execFileSync(icacls, [file], { encoding: "utf8" });
      assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users/i);
      assert.ok(acl.toLowerCase().includes((process.env.USERNAME ?? "").toLowerCase()));
    } else {
      assert.equal(statSync(file).mode & 0o077, 0);
    }
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each start issues a different token and a wrong token is rejected", async () => {
  const a = await startCompanionService({ hostId: "host-1", displayName: "Host One", readModel });
  const b = await startCompanionService({ hostId: "host-1", displayName: "Host One", readModel });
  try {
    assert.notEqual(a.info.enrollmentToken, b.info.enrollmentToken);
    assert.equal(a.info.credentialsPath, null);
    const res = await fetch(`${a.info.url}/v1/companion/authorize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", clientId: "me", enrollmentToken: b.info.enrollmentToken, capability: "read-workspace" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("aclIsOnly accepts a single matching ACE and fails closed otherwise", () => {
  const f = "C:\\x\\c.json";
  const me = "Xenos\\me";
  const tail = "\n\nSuccessfully processed 1 files; Failed processing 0 files";
  assert.equal(aclIsOnly(f + " " + me + ":(F)" + tail, f, me), true);
  assert.equal(aclIsOnly(f + " " + me + ":(F)\n      Everyone:(R)" + tail, f, me), false);
  assert.equal(aclIsOnly(f + " Everyone:(R)" + tail, f, me), false);
  assert.equal(aclIsOnly("garbage", f, me), false);
  // icacls can print the long path form while we hold the 8.3 short form (seen on the GitHub Windows runner).
  const longForm = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\nexus-svc-x\\c.json";
  assert.equal(aclIsOnly(longForm + " " + me + ":(F)" + tail, "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nexus-svc-x\\c.json", me), true);
  assert.equal(aclIsOnly(longForm + " " + me + ":(F)\n      Everyone:(R)" + tail, "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nexus-svc-x\\c.json", me), false);
});

test("an existing credentials file with broad permissions is replaced, not reused", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-svc-"));
  const file = path.join(dir, "companion.json");
  writeFileSync(file, "old");
  execFileSync(icacls, [file, "/grant", "Everyone:R"], { stdio: "ignore" });
  const service = await startCompanionService({ hostId: "host-1", displayName: "Host One", readModel, credentialsPath: file });
  try {
    assert.equal(service.info.credentialsPath, file);
    const acl = execFileSync(icacls, [file], { encoding: "utf8" });
    assert.doesNotMatch(acl, /Everyone/i);
    assert.equal((acl.match(/:\(/g) ?? []).length, 1);
    assert.match(readFileSync(file, "utf8"), /enrollmentToken/);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("if the credentials file cannot be created the server still starts and a warning is set", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-svc-"));
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "a file, not a directory");
  const service = await startCompanionService({ hostId: "host-1", displayName: "Host One", readModel, credentialsPath: path.join(blocker, "companion.json") });
  try {
    assert.equal(service.info.credentialsPath, null);
    assert.match(service.info.credentialsWarning ?? "", /credentials file not written/);
    assert.ok(service.info.enrollmentToken.length > 20);
    await service.stop();
    await service.stop(); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
