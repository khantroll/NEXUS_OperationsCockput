import type { HomeAnchor } from "../../contracts/src/index.js";

export interface LayoutRuntime {
  workspaceId: string;
  groupIds: readonly string[];
  displayIds: readonly string[];
  primaryDisplayId: string;
}

export interface ResolvedHomeAnchor {
  workspaceId: string;
  groupId: string;
  splitPath: readonly string[];
  tabIndex: number;
  fallbackZone: HomeAnchor["fallbackZone"];
  displayId: string;
  usedGroupFallback: boolean;
  usedDisplayFallback: boolean;
}

/** Resolve a persisted anchor deterministically without mutating layout state. */
export function resolveHomeAnchor(anchor: HomeAnchor, runtime: LayoutRuntime): ResolvedHomeAnchor {
  const groupExists = runtime.groupIds.includes(anchor.groupId);
  const displayExists = anchor.displayId !== undefined && runtime.displayIds.includes(anchor.displayId);
  const displayId = displayExists ? anchor.displayId! : runtime.primaryDisplayId;
  const groupId = groupExists ? anchor.groupId : `fallback:${anchor.fallbackZone}`;
  return {
    workspaceId: runtime.workspaceId,
    groupId,
    splitPath: anchor.splitPath,
    tabIndex: anchor.tabIndex,
    fallbackZone: anchor.fallbackZone,
    displayId,
    usedGroupFallback: !groupExists,
    usedDisplayFallback: !displayExists,
  };
}
