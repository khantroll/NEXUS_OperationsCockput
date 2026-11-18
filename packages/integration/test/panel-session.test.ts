import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, PanelCommand, PanelRecord } from "../../contracts/src/index.js";
import { PanelCommandProcessor } from "../../core/src/lifecycle.js";
import { PtySupervisor } from "../../host-agent/src/supervisor.js";

const shell = process.env.ComSpec ?? "cmd.exe";
const nodeProgram = ["/d", "/c", "node", "-e", "let n=0; setInterval(() => console.log('panel-tick-'+(++n)), 25);"];

function waitForData(attachment: ReturnType<PtySupervisor["attach"]>, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${needle}`));
    }, 3000);
    const unsubscribe = attachment.onData((data) => {
      if (data.includes(needle)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

const envelope = (requestId: string, expectedRevision: number, payload: PanelCommand): CommandEnvelope<PanelCommand> => ({
  requestId,
  actorId: "operator",
  expectedRevision,
  payload,
});

test("Park -> Summon -> SnapBack preserves the live host session", async () => {
  const supervisor = new PtySupervisor(4096);
  const started = supervisor.start(shell, nodeProgram, { sessionId: "integration-session" });
  const processor = new PanelCommandProcessor(() => true);
  let panel: PanelRecord = {
    panelId: "panel-1",
    sessionId: started.sessionId,
    workspaceId: "workspace-1",
    placement: "docked",
    homeAnchor: {
      workspaceId: "workspace-1",
      groupId: "terminals",
      splitPath: ["root", "left"],
      tabIndex: 0,
      fallbackZone: "center",
      layoutRevision: 1,
    },
    revision: 1,
  };
  const attachment = supervisor.attach(started.sessionId, "write");

  try {
    await waitForData(attachment, "panel-tick-2");
    const pid = supervisor.snapshot(started.sessionId).pid;

    panel = processor.process(panel, envelope("park-1", panel.revision, { op: "park", panelId: panel.panelId })).record;
    assert.equal(panel.placement, "parked");
    assert.equal(panel.sessionId, started.sessionId);
    assert.equal(supervisor.snapshot(started.sessionId).pid, pid);
    attachment.detach();

    panel = processor.process(
      panel,
      envelope("summon-1", panel.revision, { op: "summon", panelId: panel.panelId, targetSurface: "main" }),
    ).record;
    assert.equal(panel.placement, "focused");
    assert.equal(supervisor.snapshot(started.sessionId).pid, pid);

    panel = processor.process(panel, envelope("snapback-1", panel.revision, { op: "snapBack", panelId: panel.panelId })).record;
    assert.equal(panel.placement, "docked");
    assert.equal(panel.sessionId, started.sessionId);

    const reattached = supervisor.attach(started.sessionId, "read");
    assert.match(reattached.replay, /panel-tick-2/);
    assert.ok(Buffer.byteLength(reattached.replay) <= 4096);
    assert.equal((reattached.replay.match(/panel-tick-2/g) ?? []).length, 1);
    assert.equal(supervisor.snapshot(started.sessionId).pid, pid);
    reattached.detach();
  } finally {
    const termination = await supervisor.terminate(started.sessionId);
    assert.equal(termination.session.status, "exited");
    supervisor.dispose(started.sessionId);
  }
});

test("two independent panels survive lifecycle transitions and renderer-style reattach", async () => {
  const supervisor = new PtySupervisor(4096);
  const first = supervisor.start(shell, nodeProgram, { sessionId: "integration-session-a" });
  const second = supervisor.start(shell, nodeProgram, { sessionId: "integration-session-b" });
  const processor = new PanelCommandProcessor(() => true);
  const panelFor = (panelId: string, sessionId: string): PanelRecord => ({
    panelId,
    sessionId,
    workspaceId: "workspace-1",
    placement: "docked",
    homeAnchor: {
      workspaceId: "workspace-1",
      groupId: "terminals",
      splitPath: ["root", panelId],
      tabIndex: 0,
      fallbackZone: "center",
      layoutRevision: 1,
    },
    revision: 1,
  });
  const firstAttachment = supervisor.attach(first.sessionId, "write");
  const secondAttachment = supervisor.attach(second.sessionId, "write");
  try {
    await Promise.all([
      waitForData(firstAttachment, "panel-tick-2"),
      waitForData(secondAttachment, "panel-tick-2"),
    ]);
    const panels = [panelFor("panel-a", first.sessionId), panelFor("panel-b", second.sessionId)];
    const pids = panels.map((panel) => supervisor.snapshot(panel.sessionId).pid);
    for (const [index, initial] of panels.entries()) {
      let panel = processor.process(initial, envelope(`${initial.panelId}-park`, initial.revision, { op: "park", panelId: initial.panelId })).record;
      panel = processor.process(panel, envelope(`${initial.panelId}-summon`, panel.revision, { op: "summon", panelId: panel.panelId, targetSurface: "main" })).record;
      panel = processor.process(panel, envelope(`${initial.panelId}-snapback`, panel.revision, { op: "snapBack", panelId: panel.panelId })).record;
      assert.equal(panel.placement, "docked");
      assert.equal(panel.sessionId, initial.sessionId);
      assert.equal(supervisor.snapshot(panel.sessionId).pid, pids[index]);
    }
    firstAttachment.detach();
    secondAttachment.detach();
    const reattached = [supervisor.attach(first.sessionId, "read"), supervisor.attach(second.sessionId, "read")];
    for (const [index, attachment] of reattached.entries()) {
      const current = panels[index];
      assert.ok(current);
      assert.match(attachment.replay, /panel-tick-2/);
      assert.throws(() => attachment.write("blocked"), /read attachment cannot write/);
      assert.equal(supervisor.snapshot(current.sessionId).pid, pids[index]);
      attachment.detach();
    }
  } finally {
    for (const session of [first, second]) {
      const termination = await supervisor.terminate(session.sessionId);
      assert.equal(termination.session.status, "exited");
      supervisor.dispose(session.sessionId);
    }
  }
});
