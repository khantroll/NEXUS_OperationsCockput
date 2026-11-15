# Development Roadmap
Status: Proposed. Milestones are gated on verified evidence, not calendar estimates.

## M0 — Foundation and feasibility [NEXT]
- Define package boundaries and threat model; TypeScript monorepo, formatting/lint/typecheck and Windows/Linux CI.
- Electron + React + Dockview proof: split tabs, floating pane, independent native pop-out, serialize/restore.
- Host-owned Windows ConPTY proof: 2 PTYs, session registry and attach/detach, process survives **desktop UI crash**.
- Browser renderer proof: regular test page + live counter + scroll state, move/park/undock across native windows; publish compatibility matrix.
- ADRs for ambiguous technical choices. No credentials or production hosts required.
**Exit:** executable laboratory + automated lifecycle evidence and documented limitations.

## M1 — Useful local cockpit
- Workspace navigation; projects; session shelf; keyboard Summon/SnapBack and Set Home.
- Stable IDs, layout revisioning, SQLite storage, recovery and process states.
- Claude Code/Codex CLI profile launchers with configurable workdir (no secrets in config).
- Scrollback quotas, interrupt/restart/stop confirmation, status and recovery UI.
- Portable import/export of **redacted** layout metadata.
**Exit:** operate two real agent terminals while moving/parking windows and restarting desktop UI with no duplicate processes.

## M2 — Trusted remote companion
- Authenticated, private-network-only web client and API; host enrollment and revocation.
- Linux host agent, tmux-backed sessions, SSH profile management, input leases.
- Guacamole integration spike for VNC/RDP; remote status, connection errors and observability.
- Browser provider matrix for ChatGPT/Claude/Gemini (native, external fallback, auth UX).
**Exit:** remote client attaches to existing authorized terminal without exposing generic unauthenticated exec.

## M3 — Project workspaces and integrations
- Project recall and context packages; GitHub overview, CI/status adapters.
- Read-only adapters: Conclave, Tank, OpenMausBot, Hail, AI Skills.
- Activity shelf notifications, logs with redaction and audit; selective handoff to agents.
**Exit:** switching projects preserves workspace/session semantics, no unintended cross-project permissions.

## M4 — Harden / release
- Fault injection (GUI/renderer/host/network), multi-monitor regression, accessibility, performance benchmarks.
- Packaging/updater signing, migration/backup/restore, secrets handling review.
- Documentation, installer, compatibility matrix, release checklist.
**Exit:** supported platforms and tested recovery behavior published.

## Sequenced issue backlog
1. ADR + threat model
2. Monorepo + CI + contracts
3. Dockview layout spike
4. Host-owned ConPTY supervisor spike
5. WebContentsView persistence/reparent spike
6. SnapBack core state machine + tests
7. Workspace registry + SQLite
8. CLI profiles and resource telemetry
9. Web companion/auth/host enrollment
10. SSH/tmux + remote gateway integration

## Stop/go gates
- If native view reparenting loses live state, use a stable owning window/overlay in desktop and **explicitly** mark cross-window view as URL restoration, not seamless continuity.
- If Windows PTY cannot survive its owner crashing, introduce persistent supervisor/service or constrain guarantee to UI-crash survival; do not claim machine-reboot continuity.
- If provider web embeds fail, use external browser/open-url; never bypass provider security headers.
- No public exposure until threat-model review, authentication, revocation, logging, and secure config are verified.

## Definition of Done
Reproducible commands, tests, documented failure modes, security review for new privileged IPC, no fake live statuses, and PR linked to requirement/ADR. Empty checkboxes are not evidence of implementation.
