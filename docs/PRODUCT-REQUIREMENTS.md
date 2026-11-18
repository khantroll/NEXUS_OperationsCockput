# Product Requirements — NEXUS Operations Cockpit
Status: Proposed v0.1 | 2026-11-15

## Problem and mission
Users currently operate many disconnected AI CLIs, AI web chats, SSH sessions, remote desktops, repositories, and agent dashboards. NEXUS is a **human-operated cockpit** that brings these persistent environments forward, then returns them to their assigned layouts without accidentally restarting work.

## Guiding invariants
1. Presentation lifecycle and execution lifecycle are separate.
2. One stable sessionId may be represented by multiple panelIds, but interactive input ownership is exclusive unless explicitly shared.
3. Closing/parking a panel never implicitly sends a kill signal.
4. Every status is truthful: running, exited, detached, connected, reconnecting, lost, or unknown are not synonyms.
5. Moving/parking views is not authorization for programmatic agents to control them.
6. A browser companion reattaches to remote backends; it never pretends to migrate local browser execution state.

## Personas and workflows
- Primary operator on a Windows workstation; frequent use of Claude Code, Codex CLI, PowerShell, and SSH.
- Remote operator accessing persistent host sessions from another trusted computer.
- Developer switching between project-centric collections: Conclave, Tank, Hail, AI Skills, infrastructure.

### Critical workflows
1. Open Conclave project -> restore workspace layout and links to registered sessions.
2. Summon a named Claude Code PTY from the shelf -> work -> SnapBack to original tab group.
3. Park a running terminal -> observe output continue -> summon -> same process ID/session ID.
4. Detach to monitor 2 -> unplug monitor -> recover on available display.
5. Restart GUI during active host-owned terminal -> reattach; do not relaunch duplicate process.
6. Open remote browser companion -> attach to authorized remote terminal; web provider chat uses external/compatible view with disclosure of limitations.

## Priorities
P0 design/spike:
- React/Electron docking shell with tabs, resizing, focus/float/park/snapback.
- Durable Windows host-owned PTY prototype with stable ID and bounded replay.
- Layout persistence, named projects, session registry contract and state reporting.
- One compatible test web view; test same-window and cross-window move state.
- Security boundaries for local IPC, origin validation, non-secret persistence.
- CI on Windows/Linux, typed contracts, lifecycle tests.

P1:
- SSH/tmux remote attachment; web companion; authenticated private remote access.
- Web chat profiles (ChatGPT/Claude/Gemini) individually tested for compatibility.
- Guacamole-backed RDP/VNC/SSH; multi-monitor hotplug and session shelf notifications.
- Snapshot/export and session recovery, with privacy-safe log defaults.

P2:
- Conclave/Tank/OpenMausBot/Hail adapters, project status panels, capability-driven automation, quota surfaces, optional multi-user support.

## Nonfunctional goals
- No duplicated PTY sessions during panel move or GUI restart.
- Crash isolation: a renderer crash cannot terminate host-owned processes.
- Resource visibility and limits: process count, memory, IO buffering, render suspension.
- No secrets in SQLite layout snapshots, logs, screenshots, CI, or URLs.
- Private-network-only remote access for early releases.
- Accessibility: keyboard navigation and shortcuts, high-contrast, screen reader labeling.

## Out of scope
- Secret extraction/cookie transfer from provider sites.
- Circumventing anti-framing, login, or policy protections.
- Autonomous agent terminal input during v0.1.
- Production-municipal-system connections during the prototype.
- Cross-device transport of an Electron renderer's live JavaScript heap.

## Acceptance criteria for first proof
- Two real terminals have distinct session IDs and run simultaneous commands.
- Park/summon/snapback while a process prints sequential output: same session ID and PID before/after.
- GUI restart -> reconnect surviving terminal and replay bounded buffered output, no duplicate command launch.
- Explicit terminate -> process ends and UI marks exited.
- Persisted anchor reconstructs when tab group changes; monitor removal falls back onscreen.
- Browser test establishes which transitions preserve runtime state and which only restore URLs.
- Invalid remote/IPC control requests fail closed.

See architecture, lifecycle, security, roadmap, and ADR documents for details.
