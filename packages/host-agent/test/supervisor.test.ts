import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../contracts/src/index.js";
import { PtySupervisor, resolveCliProfile, type SessionMetadataSink } from "../src/supervisor.js";

let conptyCleanupDiagnostics = 0;
process.on("uncaughtException", (error) => {
  if (error instanceof Error && error.message === "AttachConsole failed") {
    conptyCleanupDiagnostics += 1;
    return;
  }
  throw error;
});
process.on("exit", () => {
  if (conptyCleanupDiagnostics > 0) {
    console.warn(`node-pty emitted ${conptyCleanupDiagnostics} known ConPTY cleanup diagnostic(s)`);
  }
});

const node = process.execPath;
const shell = process.env.ComSpec ?? "cmd.exe";
const tickProgram = "let n=0; setInterval(() => console.log('tick-'+(++n)), 25);";
const nodeInShell = ["/d", "/c", "node", "-e", tickProgram];

test("CLI profiles resolve only allowlisted launchers and absolute workdirs", () => {
  assert.deepEqual(resolveCliProfile({ profileId: "claude", name: "Claude Code", executable: "claude", args: ["--version"], cwd: "C:\\work" }, "win32", "cmd.exe", {}), {
    file: "claude.cmd",
    args: ["--version"],
    cwd: "C:\\work",
  });
  assert.deepEqual(resolveCliProfile({ profileId: "shell", name: "Command shell", executable: "shell", args: ["/d", "/c", "echo", "ok"] }, "win32", "custom-shell.exe"), {
    file: "custom-shell.exe",
    args: ["/d", "/c", "echo", "ok"],
  });
  assert.throws(() => resolveCliProfile({ profileId: "", name: "bad", executable: "codex", args: [] }), /profile ID/);
  assert.throws(() => resolveCliProfile({ profileId: "bad", name: "bad", executable: "codex", args: [], cwd: "relative" }), /absolute path/);
  assert.throws(() => resolveCliProfile({ profileId: "bad", name: "bad", executable: "codex", args: ["bad\u0000arg"] }), /invalid argument/);
  assert.throws(() => resolveCliProfile({ profileId: "bad", name: "bad", executable: "codex", args: ["--token=not-for-persistence"] }), /credential-shaped/);
});

test("a shell profile launches through the supervisor boundary", async () => {
  const supervisor = new PtySupervisor(1024);
  const session = supervisor.startProfile({
    profileId: "profile-shell",
    name: "Profile shell",
    executable: "shell",
    args: ["/d", "/c", "echo", "profile-launch"],
  }, { sessionId: "profile-shell-session" });
  await supervisor.waitForExit(session.sessionId);
  const attachment = supervisor.attach(session.sessionId, "read");
  assert.match(attachment.replay, /profile-launch/);
  attachment.detach();
  supervisor.dispose(session.sessionId);
});

test("interrupt, restart, and explicit cleanup preserve stable session identity", async () => {
  const supervisor = new PtySupervisor(1024);
  const profile = { profileId: "profile-loop", name: "Loop", executable: "shell" as const, args: ["/d", "/c", "node", "-e", "setInterval(() => console.log('loop'), 25)"] };
  const first = supervisor.startProfile(profile, { sessionId: "profile-recovery" });
  let currentSessionId = first.sessionId;
  try {
    const interrupted = await supervisor.interrupt(first.sessionId);
    assert.ok(interrupted.status === "running" || interrupted.status === "exited");
    const restarted = await supervisor.restartProfile(first.sessionId, { ...profile, args: ["/d", "/c", "echo", "restarted"] });
    currentSessionId = restarted.sessionId;
    assert.equal(restarted.sessionId, first.sessionId);
    await supervisor.waitForExit(restarted.sessionId);
    supervisor.dispose(restarted.sessionId);
    assert.throws(() => supervisor.snapshot(first.sessionId), /unknown session/);
  } finally {
    try {
      if (supervisor.snapshot(currentSessionId).status === "running") await supervisor.terminate(currentSessionId);
    } catch {
      // The explicit cleanup path may already have disposed the session.
    }
    try { supervisor.dispose(currentSessionId); } catch { /* already disposed */ }
  }
});

test("restart rejects attached sessions before terminating them", async () => {
  const supervisor = new PtySupervisor(1024);
  const profile = { profileId: "attached-loop", name: "Attached loop", executable: "shell" as const, args: ["/d", "/c", "node", "-e", "setInterval(() => {}, 1000)"] };
  const session = supervisor.startProfile(profile, { sessionId: "attached-restart" });
  const attachment = supervisor.attach(session.sessionId, "read");
  try {
    await assert.rejects(() => supervisor.restartProfile(session.sessionId, { ...profile, args: ["/d", "/c", "echo", "replacement"] }), /attached session/);
    assert.equal(supervisor.snapshot(session.sessionId).status, "running");
  } finally {
    attachment.detach();
    await supervisor.terminate(session.sessionId);
    supervisor.dispose(session.sessionId);
  }
});

function waitForData(attachment: ReturnType<PtySupervisor["attach"]>, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${needle}; received=${JSON.stringify(received.slice(-200))}`));
    }, 3000);
    const unsubscribe = attachment.onData((data) => {
      received += data;
      if (data.includes(needle)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

test("two independent ConPTY sessions survive detach and replay bounded output", async () => {
  const supervisor = new PtySupervisor(4096);
  const first = supervisor.start(shell, nodeInShell, { sessionId: "pty-1" });
  const second = supervisor.start(shell, nodeInShell, { sessionId: "pty-2" });
  try {
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.pid, second.pid);

    const firstAttachment = supervisor.attach(first.sessionId, "write");
    const secondAttachment = supervisor.attach(second.sessionId, "write");
    await Promise.all([waitForData(firstAttachment, "tick-2"), waitForData(secondAttachment, "tick-2")]);
    const firstPid = supervisor.snapshot(first.sessionId).pid;
    const secondPid = supervisor.snapshot(second.sessionId).pid;
    firstAttachment.detach();
    secondAttachment.detach();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const reattachedFirst = supervisor.attach(first.sessionId, "read");
    const reattachedSecond = supervisor.attach(second.sessionId, "read");
    assert.match(reattachedFirst.replay, /tick-2/);
    assert.match(reattachedSecond.replay, /tick-2/);
    assert.equal(supervisor.snapshot(first.sessionId).pid, firstPid);
    assert.equal(supervisor.snapshot(second.sessionId).pid, secondPid);
    assert.throws(() => reattachedFirst.write("blocked"), /read attachment cannot write/);
    reattachedFirst.detach();
    reattachedSecond.detach();
  } finally {
    const [firstTermination, secondTermination] = await Promise.all([
      supervisor.terminate(first.sessionId),
      supervisor.terminate(second.sessionId),
    ]);
    assert.equal(firstTermination.session.status, "exited");
    assert.equal(secondTermination.session.status, "exited");
    supervisor.dispose(first.sessionId);
    supervisor.dispose(second.sessionId);
  }
});

test("output replay is bounded and termination is explicit", async () => {
  const supervisor = new PtySupervisor(32);
  const session = supervisor.start(shell, ["/d", "/c", "node", "-e", "console.log('0123456789012345678901234567890123456789')"], {
    sessionId: "pty-bounded",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const attachment = supervisor.attach(session.sessionId, "read");
  assert.ok(Buffer.byteLength(attachment.replay) <= 32);
  attachment.detach();
  const termination = await supervisor.terminate(session.sessionId);
  assert.equal(termination.session.status, "exited");
  supervisor.dispose(session.sessionId);
});

test("disposal requires every attachment to detach", async () => {
  const supervisor = new PtySupervisor(64);
  const session = supervisor.start(shell, ["/d", "/c", "echo", "dispose-test"], { sessionId: "pty-dispose" });
  await supervisor.waitForExit(session.sessionId);
  const attachment = supervisor.attach(session.sessionId, "read");
  assert.throws(() => supervisor.dispose(session.sessionId), /attached session/);
  attachment.detach();
  supervisor.dispose(session.sessionId);
});

test("optional metadata sink tracks PTY lifecycle without owning the process", async () => {
  const records: SessionRecord[] = [];
  const metadata: SessionMetadataSink = { saveSession: (record) => records.push(record) };
  const supervisor = new PtySupervisor({
    metadata,
    hostId: "test-host",
    hostBootEpoch: "test-boot",
  });
  const session = supervisor.start(shell, ["/d", "/c", "echo", "metadata-test"], {
    sessionId: "pty-metadata",
  });
  await supervisor.waitForExit(session.sessionId);
  assert.equal(records[0]?.transport, "connected");
  assert.equal(records.at(-1)?.transport, "disconnected");
  assert.equal(records.at(-1)?.process, "exited");
  assert.equal(records.at(-1)?.recovery, "none");
  assert.equal(records.at(-1)?.hostBootEpoch, "test-boot");
  assert.equal(records.at(-1)?.createdAt, records[0]?.createdAt);
  supervisor.dispose(session.sessionId);
});
