import assert from "node:assert/strict";
import test from "node:test";
import { PtySupervisor } from "../src/supervisor.js";

const node = process.execPath;
const shell = process.env.ComSpec ?? "cmd.exe";
const tickProgram = "let n=0; setInterval(() => console.log('tick-'+(++n)), 25);";
const nodeInShell = ["/d", "/c", "node", "-e", tickProgram];

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
