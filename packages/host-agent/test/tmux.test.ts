import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { TmuxBackend, TmuxCommandError, toSessionRecord, type TmuxRunner } from "../src/tmux.js";

function fake(responses: Array<string | Error> = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = async (args) => {
    calls.push([...args]);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  };
  return { run, calls };
}

const noServer = new TmuxCommandError("x", "no server running on /tmp/tmux-1/nexus");
const noSession = new TmuxCommandError("x", "can't find session: nexus-a");

test("start builds one argv-only invocation, avoids sh -c, and validates inputs", async () => {
  const f = fake(["", "nexus-a|42|0|\n"]);
  const backend = new TmuxBackend({ run: f.run });
  const snapshot = await backend.start("claude", ["--version", "; rm -rf /"], { sessionId: "a", cwd: "/work", cols: 100, rows: 30 });
  assert.deepEqual(snapshot, { sessionId: "a", pid: 42, status: "running" });
  const start = f.calls[0]!;
  assert.deepEqual(start.slice(0, 13), ["start-server", ";", "set-option", "-g", "exit-empty", "off", ";", "set-option", "-g", "remain-on-exit", "on", ";", "set-option"]);
  assert.deepEqual(start.slice(start.indexOf("new-session")), ["new-session", "-d", "-s", "nexus-a", "-x", "100", "-y", "30", "-c", "/work", "--", "claude", "--version", "; rm -rf /"]);
  // A lone command argument would be run through sh -c by tmux, so it is wrapped in "env --".
  const lone = fake(["", "nexus-b|1|0|\n"]);
  await new TmuxBackend({ run: lone.run }).start("some tool", [], { sessionId: "b" });
  assert.deepEqual(lone.calls[0]!.slice(lone.calls[0]!.indexOf("--")), ["--", "env", "--", "some tool"]);
  await assert.rejects(backend.start("x", [], { sessionId: "bad id;" }), /invalid session ID/);
  await assert.rejects(backend.start("x", [], { sessionId: "../x" }), /invalid session ID/);
  await assert.rejects(backend.start("x", [], { sessionId: "ok", cwd: "relative" }), /absolute/);
  await assert.rejects(backend.start("x", ["a\u0000b"], { sessionId: "ok" }), /invalid arguments/);
  await assert.rejects(backend.start("x", [], { sessionId: "ok", cols: 5 }), /terminal size/);
  await assert.rejects(backend.start("sh", ["x;", "run-shell", "touch /tmp/pwned"], { sessionId: "ok" }), /must not end with ';'/);
  await assert.rejects(backend.start("x;", [], { sessionId: "ok" }), /must not end with ';'/);
  await assert.rejects(backend.start("sh", [], { sessionId: "ok", cwd: "/work;" }), /must not end with ';'/);
});

test("server options ride along with every start so a restarted tmux server cannot lose them", async () => {
  const f = fake();
  const backend = new TmuxBackend({ run: f.run, maxScrollbackLines: 2000 });
  await backend.start("sh", ["-c", "true"], { sessionId: "a" }).catch(() => undefined);
  await backend.start("sh", ["-c", "true"], { sessionId: "b" }).catch(() => undefined);
  const starts = f.calls.filter((c) => c[0] === "start-server");
  assert.equal(starts.length, 2);
  for (const call of starts) {
    assert.ok(call.join(" ").includes("remain-on-exit on"));
    assert.ok(call.join(" ").includes("history-limit 2000"));
  }
});

test("list parses running and exited sessions, ignores foreign sessions, and tolerates no server", async () => {
  const f = fake(["nexus-a|10|0|\nnexus-b|11|1|7\nmine|12|0|\nnexus-bad id|13|0|\n\n"]);
  const backend = new TmuxBackend({ run: f.run });
  assert.deepEqual(await backend.list(), [
    { sessionId: "a", pid: 10, status: "running" },
    { sessionId: "b", pid: 11, status: "exited", exitCode: 7 },
  ]);
  assert.deepEqual(await new TmuxBackend({ run: fake([noServer]).run }).list(), []);
  await assert.rejects(new TmuxBackend({ run: fake([new TmuxCommandError("x", "permission denied")]).run }).list(), { name: "TmuxCommandError" });
});

test("a permission error on the tmux socket is not treated as no server", async () => {
  const denied = new TmuxCommandError("x", "error connecting to /tmp/tmux-1/nexus-cockpit (Permission denied)");
  await assert.rejects(new TmuxBackend({ run: fake([denied]).run }).list(), { name: "TmuxCommandError" });
  await assert.rejects(new TmuxBackend({ run: fake([denied]).run }).kill("a"), { name: "TmuxCommandError" });
  const gone = new TmuxCommandError("x", "error connecting to /tmp/tmux-1/nexus-cockpit (No such file or directory)");
  assert.deepEqual(await new TmuxBackend({ run: fake([gone]).run }).list(), []);
});

test("input is literal, bounded, and targets the exact session", async () => {
  const f = fake();
  const backend = new TmuxBackend({ run: f.run });
  await backend.sendInput("a", "-l; C-c\n");
  assert.deepEqual(f.calls[0], ["send-keys", "-t", "=nexus-a:", "-l", "--", "-l; C-c\n"]);
  await assert.rejects(backend.sendInput("a", "x".repeat(70_000)), /invalid input/);
  await assert.rejects(backend.sendInput("a", "a\u0000b"), /invalid input/);
  await backend.interrupt("a");
  assert.deepEqual(f.calls[1], ["send-keys", "-t", "=nexus-a:", "C-c"]);
  // Arguments ending in ";" are tmux command separators, so trailing semicolons are sent as hex bytes.
  f.calls.length = 0;
  await backend.sendInput("a", "ls;;");
  assert.deepEqual(f.calls, [["send-keys", "-t", "=nexus-a:", "-l", "--", "ls"], ["send-keys", "-t", "=nexus-a:", "-H", "3b", "3b"]]);
  f.calls.length = 0;
  await backend.sendInput("a", ";");
  assert.deepEqual(f.calls, [["send-keys", "-t", "=nexus-a:", "-H", "3b"]]);
  await assert.rejects(new TmuxBackend({ run: fake([noSession]).run }).sendInput("a", "x"), /unknown session: a/);
});

test("capture truncates to the most recent bytes and kill is idempotent", async () => {
  const backend = new TmuxBackend({ run: fake(["0123456789"]).run, maxReplayBytes: 4 });
  assert.equal(await backend.capture("a"), "6789");
  await new TmuxBackend({ run: fake([noSession]).run }).kill("a");
  await new TmuxBackend({ run: fake([noServer]).run }).kill("a");
  const f = fake();
  await new TmuxBackend({ run: f.run }).kill("a");
  assert.deepEqual(f.calls[0], ["kill-session", "-t", "=nexus-a"]);
});

test("toSessionRecord marks surviving tmux sessions reconnectable and exited ones final", () => {
  const live = toSessionRecord({ sessionId: "a", pid: 1, status: "running" }, "linux-1", "epoch-2", "2026-11-17T00:00:00.000Z");
  assert.equal(live.recovery, "reconnectable");
  assert.equal(live.process, "running");
  const dead = toSessionRecord({ sessionId: "b", pid: 2, status: "exited", exitCode: 3 }, "linux-1", "epoch-2", "2026-11-17T00:00:00.000Z");
  assert.equal(dead.process, "exited");
  assert.equal(dead.exitCode, 3);
  assert.equal(dead.recovery, "none");
});

function tmuxPresent(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("real tmux: sessions survive a new backend instance, accept input, report exit, and clean up", { skip: !tmuxPresent() && "tmux not installed" }, async () => {
  const socketName = `nexus-test-${process.pid}-${Date.now()}`;
  const backend = new TmuxBackend({ socketName });
  try {
    await backend.assertAvailable();
    const started = await backend.start("sh", ["-c", "echo ready; cat"], { sessionId: "live" });
    assert.equal(started.status, "running");
    await backend.start("sh", ["-c", "echo done; exit 7"], { sessionId: "short" });
    await assert.rejects(backend.start("sh", [], { sessionId: "live" }), /already exists/);

    // A fresh backend (simulating a supervisor restart) finds the survivors.
    const restarted = new TmuxBackend({ socketName });
    let sessions = await restarted.list();
    for (let i = 0; i < 40 && sessions.find((s) => s.sessionId === "short")?.status !== "exited"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sessions = await restarted.list();
    }
    assert.equal(sessions.find((s) => s.sessionId === "live")?.status, "running");
    assert.equal(sessions.find((s) => s.sessionId === "live")?.pid, started.pid);
    assert.deepEqual(sessions.find((s) => s.sessionId === "short"), { sessionId: "short", pid: sessions.find((s) => s.sessionId === "short")!.pid, status: "exited", exitCode: 7 });

    await restarted.sendInput("live", "hello-from-test\n");
    let text = "";
    for (let i = 0; i < 40 && !text.includes("hello-from-test"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      text = await restarted.capture("live");
    }
    assert.ok(text.includes("ready"));
    assert.ok(text.includes("hello-from-test"));

    await restarted.kill("live");
    await restarted.kill("live"); // idempotent
    await restarted.kill("short");
    assert.deepEqual(await restarted.list(), []);
  } finally {
    try { execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});

test("real tmux: injection attempts are refused or neutralised", { skip: !tmuxPresent() && "tmux not installed" }, async () => {
  const socketName = `nexus-test-inj-${process.pid}-${Date.now()}`;
  const backend = new TmuxBackend({ socketName });
  const raw = (...args: string[]): string => execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    await assert.rejects(backend.start("sh", ["x;", "set-environment", "-g", "PWNED", "1"], { sessionId: "inj" }), /must not end with ';'/);
    assert.throws(() => raw("show-environment", "-g", "PWNED"));
    // A lone "file" must not be interpreted by a shell: "exit 0" would succeed under sh -c, but is not a program.
    await backend.start("exit 0", [], { sessionId: "lone" });
    let snap = await backend.snapshot("lone");
    for (let i = 0; i < 40 && snap.status !== "exited"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snap = await backend.snapshot("lone");
    }
    assert.equal(snap.status, "exited");
    assert.notEqual(snap.exitCode, 0);
  } finally {
    try { execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});

test("real tmux: trailing semicolons, interrupt with exit status, and capture of an exited pane", { skip: !tmuxPresent() && "tmux not installed" }, async () => {
  const socketName = `nexus-test-io-${process.pid}-${Date.now()}`;
  const backend = new TmuxBackend({ socketName });
  const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 50; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("condition not met in time");
  };
  try {
    await backend.start("sh", ["-c", "cat"], { sessionId: "io" });
    await backend.sendInput("io", "a;b;");
    await backend.sendInput("io", ";");
    await waitFor(async () => (await backend.capture("io")).includes("a;b;;"));
    await backend.start("sh", ["-c", "trap 'echo got-int; exit 3' INT; echo armed; while true; do sleep 1; done"], { sessionId: "sig" });
    await waitFor(async () => (await backend.capture("sig")).includes("armed"));
    await backend.interrupt("sig");
    await waitFor(async () => (await backend.snapshot("sig")).status === "exited");
    assert.equal((await backend.snapshot("sig")).exitCode, 3);
    assert.ok((await backend.capture("sig")).includes("got-int"));
  } finally {
    try { execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});
