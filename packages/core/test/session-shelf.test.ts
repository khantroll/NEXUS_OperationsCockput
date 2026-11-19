import assert from "node:assert/strict";
import test from "node:test";
import {
  isHiddenShelfSession,
  isLabOrDemoSession,
  sessionDisplayName,
  sessionsToClearExited,
  sessionsToClearLab,
  visibleShelfSessions,
  type ShelfSession,
} from "../src/session-shelf.js";

function session(partial: Partial<ShelfSession> & Pick<ShelfSession, "sessionId">): ShelfSession {
  return {
    kind: "local-pty",
    process: "running",
    recovery: "none",
    ...partial,
  };
}

test("sessionDisplayName prefers profile label and cwd over kind plus id", () => {
  assert.equal(sessionDisplayName(session({ sessionId: "abcdef012345", label: "Shell", cwd: "C:\\\\work" })), "Shell · C:\\\\work");
  assert.equal(sessionDisplayName(session({ sessionId: "abcdef012345", label: "Claude Code" })), "Claude Code");
  assert.equal(sessionDisplayName(session({ sessionId: "abcdef012345" })), "local-pty · abcdef01");
});

test("the default shelf hides exited, unknown, failed, and relaunch-only sessions", () => {
  const running = session({ sessionId: "run", process: "running" });
  const exited = session({ sessionId: "done", process: "exited" });
  const unknown = session({ sessionId: "lost", process: "unknown", recovery: "relaunch-only" });
  const failed = session({ sessionId: "fail", process: "failed" });
  const onlyRecovery = session({ sessionId: "stale", process: "running", recovery: "relaunch-only" });
  assert.equal(isHiddenShelfSession(running), false);
  assert.equal(isHiddenShelfSession(exited), true);
  assert.equal(isHiddenShelfSession(unknown), true);
  assert.equal(isHiddenShelfSession(failed), true);
  assert.equal(isHiddenShelfSession(onlyRecovery), true);
  assert.deepEqual(visibleShelfSessions([running, exited, unknown, failed, onlyRecovery], false).map((item) => item.sessionId), ["run"]);
  assert.equal(visibleShelfSessions([running, exited], true).length, 2);
});

test("clear-exited and clear-lab select distinct leftover session ids", () => {
  const sessions = [
    session({ sessionId: "live", process: "running" }),
    session({ sessionId: "old", process: "exited" }),
    session({ sessionId: "desktop-demo-session", process: "exited" }),
    session({ sessionId: "desktop-profile-smoke-1", process: "exited" }),
    session({ sessionId: "demo-session", process: "unknown", recovery: "relaunch-only" }),
  ];
  assert.deepEqual(sessionsToClearExited(sessions), ["old"]);
  assert.deepEqual(sessionsToClearLab(sessions), ["desktop-demo-session", "desktop-profile-smoke-1", "demo-session"]);
  assert.equal(isLabOrDemoSession({ sessionId: "live" }), false);
});
