import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, PanelCommand, PanelRecord } from "../../contracts/src/index.js";
import { applyPanelCommand, PanelCommandProcessor } from "../src/lifecycle.js";

const panel: PanelRecord = {
  panelId: "panel-1",
  sessionId: "session-1",
  workspaceId: "workspace-1",
  placement: "docked",
  homeAnchor: {
    workspaceId: "workspace-1",
    groupId: "agents",
    splitPath: ["root", "left"],
    tabIndex: 0,
    fallbackZone: "center",
    displayId: "primary",
    layoutRevision: 1,
  },
  revision: 1,
};

function command(payload: PanelCommand, expectedRevision: number): CommandEnvelope<PanelCommand> {
  return { requestId: crypto.randomUUID(), actorId: "test", expectedRevision, payload };
}

test("park, summon, and SnapBack only change presentation state", () => {
  const parked = applyPanelCommand(panel, command({ op: "park", panelId: panel.panelId }, 1));
  assert.equal(parked.result.accepted, true);
  assert.equal(parked.record.placement, "parked");
  assert.equal(parked.record.surfaceId, undefined);
  assert.equal(parked.record.sessionId, panel.sessionId);
  assert.equal(parked.record.revision, 2);

  const summoned = applyPanelCommand(
    parked.record,
    command({ op: "summon", panelId: panel.panelId, targetSurface: "main" }, 2),
  );
  assert.equal(summoned.record.placement, "focused");
  assert.equal(summoned.record.surfaceId, "main");
  assert.equal(summoned.record.sessionId, panel.sessionId);

  const restored = applyPanelCommand(
    summoned.record,
    command({ op: "snapBack", panelId: panel.panelId }, 3),
  );
  assert.equal(restored.record.placement, "docked");
  assert.equal(restored.record.surfaceId, undefined);
  assert.deepEqual(restored.record.homeAnchor, panel.homeAnchor);
  assert.equal(restored.record.sessionId, panel.sessionId);
});

test("stale revisions fail closed without changing the record", () => {
  const transition = applyPanelCommand(panel, command({ op: "park", panelId: panel.panelId }, 99));
  assert.equal(transition.result.accepted, false);
  assert.equal(transition.result.reason, "stale-revision");
});

test("repeating an already-applied presentation command is idempotent", () => {
  const first = applyPanelCommand(panel, command({ op: "park", panelId: panel.panelId }, 1));
  const second = applyPanelCommand(
    first.record,
    command({ op: "park", panelId: panel.panelId }, first.record.revision),
  );
  assert.equal(second.result.accepted, true);
  assert.equal(second.record.revision, first.record.revision);
  assert.deepEqual(second.record, first.record);
});

test("the command boundary replays a completed request by request ID", () => {
  const processor = new PanelCommandProcessor(() => true);
  const envelope = command({ op: "park", panelId: panel.panelId }, panel.revision);
  const first = processor.process(panel, envelope);
  const retry = processor.process(panel, envelope);
  assert.deepEqual(retry, first);
  assert.equal(retry.record.revision, 2);
});

test("a focused panel can be summoned to a different surface", () => {
  const processor = new PanelCommandProcessor(() => true);
  const focused = processor.process(
    panel,
    command({ op: "summon", panelId: panel.panelId, targetSurface: "main" }, panel.revision),
  );
  const moved = processor.process(
    focused.record,
    command({ op: "summon", panelId: panel.panelId, targetSurface: "popout" }, focused.record.revision),
  );
  assert.equal(moved.record.placement, "focused");
  assert.equal(moved.record.surfaceId, "popout");
  assert.equal(moved.record.revision, focused.record.revision + 1);
});

test("authorization is enforced at the command boundary", () => {
  const processor = new PanelCommandProcessor((actorId) => actorId === "operator");
  const transition = processor.process(
    panel,
    { ...command({ op: "park", panelId: panel.panelId }, panel.revision), actorId: "guest" },
  );
  assert.equal(transition.result.accepted, false);
  assert.equal(transition.result.reason, "unauthorized");
  assert.deepEqual(transition.record, panel);
});

test("omitting an authorization policy fails closed", () => {
  const transition = new PanelCommandProcessor().process(
    panel,
    command({ op: "park", panelId: panel.panelId }, panel.revision),
  );
  assert.equal(transition.result.accepted, false);
  assert.equal(transition.result.reason, "unauthorized");
});

test("completed request replay is bounded by the configured retention", () => {
  const processor = new PanelCommandProcessor(() => true, { maxCompletedRequests: 1 });
  const first = command({ op: "park", panelId: panel.panelId }, panel.revision);
  const firstResult = processor.process(panel, first);
  const second = command(
    { op: "summon", panelId: panel.panelId, targetSurface: "main" },
    firstResult.record.revision,
  );
  const secondResult = processor.process(firstResult.record, second);

  // The first entry was evicted, so it is evaluated as a fresh stale command
  // against the committed record rather than replaying or re-executing it.
  const afterEviction = processor.process(secondResult.record, first);
  assert.equal(afterEviction.result.accepted, false);
  assert.equal(afterEviction.result.reason, "stale-revision");
});

test("retries are re-authorized even when the result is cached", () => {
  let allowed = true;
  const processor = new PanelCommandProcessor(() => allowed);
  const envelope = command({ op: "park", panelId: panel.panelId }, panel.revision);
  assert.equal(processor.process(panel, envelope).result.accepted, true);
  allowed = false;
  const retry = processor.process(panel, envelope);
  assert.equal(retry.result.accepted, false);
  assert.equal(retry.result.reason, "unauthorized");
});

test("replay retention must be a positive integer", () => {
  assert.throws(() => new PanelCommandProcessor(() => true, { maxCompletedRequests: 0 }), RangeError);
  assert.throws(() => new PanelCommandProcessor(() => true, { maxCompletedRequests: 1.5 }), RangeError);
});

test("invalid commands do not mutate the current record", () => {
  const transition = applyPanelCommand(
    panel,
    command({ op: "summon", panelId: "other", targetSurface: "main" }, panel.revision),
  );
  assert.equal(transition.result.accepted, false);
  assert.equal(transition.result.reason, "invalid-command");
});
