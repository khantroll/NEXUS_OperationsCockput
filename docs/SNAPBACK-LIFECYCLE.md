# SnapBack and Summon — Lifecycle Contract
Status: design contract, not implementation.

## Definitions
**Summon**: bring an already registered session/panel to an active surface. A summon may make the existing panel visible, relocate it, or create a new read-only presentation, but may not silently start a duplicate process.
**SnapBack**: return a panel presentation to its explicit `homeAnchor`.
**Park**: remove an active panel from the workspace without disposing of its host-owned process.
**Set Home**: deliberate action to replace its anchor; ordinary dragging does not rewrite home.

## Commands and invariants
- `panel.park(panelId, expectedRevision)`
- `panel.summon(panelId, targetSurface, expectedRevision)`
- `panel.snapBack(panelId, expectedRevision)`
- `panel.setHome(panelId, anchor, expectedRevision)`
- `session.attach(sessionId, clientId, mode)`
- `session.detach(attachmentId)`
- `session.terminate(sessionId, confirmationToken)` (separate privileged action)
- `session.acquireInputLease(sessionId, attachmentId)`
Every call has an idempotency key, permission check and revision guard.

## State machine
```
             summon/focus
 parked ───────────────────────► focused
   ▲                              │
   │ park                         │ snapBack
   │                              ▼
 docked ◄──── snapBack ───── floating/detached
   │                             ▲
   └──────── float/detach ───────┘
```
Presentation transitions do not call `terminate`, `kill`, or `spawn`. A transition failure rolls back placement metadata without claiming lost process state. Transport/process statuses evolve independently.

## Anchor data
```json
{
  "workspaceId": "conclave",
  "groupId": "agent-terminals",
  "splitPath": ["root", "left", "top"],
  "tabIndex": 0,
  "fallbackZone": "center",
  "displayId": "primary",
  "layoutRevision": 12
}
```
A deleted group is recreated or mapped to fallback zone. A missing display maps to the primary available display with bounds clamped onscreen.

## Persistence and recovery
1. Persist desired layout revision transactionally before confirming the UI command.
2. Detach visual binding, never backend ownership, during a panel relocation.
3. Reattach an existing presentation adapter; preserve focus/input lease only if allowed.
4. SnapBack resolves anchor and verifies panel revision.
5. On UI restart, enumerate host sessions; reconcile registry with host truth.
6. Unknown PID/renderer/connection remains `unknown` until confirmed. Never infer it is running from previous cache.
7. Reconnection to remote desktop depends on remote OS/session; renderer memory preservation is best-effort and must be labeled separately.

## Cross-device semantics
The remote browser can attach to a terminal backend and share session ID. It cannot teleport a native Electron WebContentsView. When remote access switches surfaces, restore a URL/document reference for supported browser apps and disclose that in-memory page state may be lost.

## Concurrency
Default one writer, many observers. Input lease expires and revokes when client disconnects; explicit transfer confirmation for stealing control. Concurrent SnapBack/summon operations use revision compare-and-swap; duplicate command IDs are no-ops.

## Failure tests
- Run incrementing counter in two shells; park both; summon; verify PID/sessionId, monotonic output.
- SnapBack after deleting original tab group.
- Float -> second monitor -> unplug -> SnapBack.
- Kill renderer; keep host process alive; reconnect.
- Kill host agent; display unknown/lost rather than fabricated running.
- Two clients compete for write lease; only one succeeds.
- Simulate stale layout revision; command rejected or reconciled without duplicate view.
- Browser test page stores in-memory counter; move between same window, popout, park, restart and report precise continuity results.
