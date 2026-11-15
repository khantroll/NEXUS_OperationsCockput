import assert from "node:assert/strict";
import test from "node:test";
import type { HomeAnchor } from "../../contracts/src/index.js";
import { resolveHomeAnchor } from "../src/layout.js";

const anchor: HomeAnchor = {
  workspaceId: "workspace-1",
  groupId: "missing-group",
  splitPath: ["root", "left", "top"],
  tabIndex: 2,
  fallbackZone: "right",
  displayId: "monitor-2",
  layoutRevision: 7,
};

test("missing groups and displays resolve to deterministic fallbacks", () => {
  assert.deepEqual(
    resolveHomeAnchor(anchor, {
      workspaceId: "workspace-1",
      groupIds: ["agents"],
      displayIds: ["primary"],
      primaryDisplayId: "primary",
    }),
    {
      workspaceId: "workspace-1",
      groupId: "fallback:right",
      splitPath: ["root", "left", "top"],
      tabIndex: 2,
      fallbackZone: "right",
      displayId: "primary",
      usedGroupFallback: true,
      usedDisplayFallback: true,
    },
  );
});

test("existing group and display remain unchanged", () => {
  const resolved = resolveHomeAnchor(anchor, {
    workspaceId: "workspace-1",
    groupIds: ["missing-group"],
    displayIds: ["monitor-2", "primary"],
    primaryDisplayId: "primary",
  });
  assert.equal(resolved.groupId, "missing-group");
  assert.equal(resolved.displayId, "monitor-2");
  assert.equal(resolved.usedGroupFallback, false);
  assert.equal(resolved.usedDisplayFallback, false);
});
