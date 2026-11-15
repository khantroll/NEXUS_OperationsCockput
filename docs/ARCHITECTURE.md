# Architecture — Hybrid Control Plane
Status: Proposed; implementation not yet validated.

## Logical deployment
```
Windows Xenos                                  Trusted remote browser
┌────────────────────────────┐               ┌────────────────────┐
│ Electron shell             │               │ React web client   │
│ Dockview / browser adapter │               │ terminal/RDP views │
└──────────────┬─────────────┘               └────────┬───────────┘
               │                                      │
               └──────────────┬───────────────────────┘
                              │ authenticated API / WS
                  ┌───────────▼────────────┐
                  │ Control plane          │
                  │ registry / layouts     │
                  │ capabilities / events  │
                  │ SQLite non-secret data │
                  └──────┬────────┬────────┘
                         │        │
                ┌────────▼─┐  ┌───▼────────────┐
                │ Host     │  │ Remote gateway│
                │ agents   │  │ SSH/RDP/VNC    │
                │ Win/Linux│  │ Guacamole     │
                └─────┬────┘  └────────────────┘
                      │
               PTY / tmux processes
```

## Core modules
- `apps/desktop`: Electron privileged main process, safe preload, React UI, native view adapter.
- `apps/web`: authenticated browser companion; no direct host command execution.
- `services/control-plane`: API/WebSocket, policy, workspace/event/session registry.
- `services/host-agent`: PTY process ownership, input/output channels, bounded output spool, heartbeat, shutdown/recovery protocol.
- `services/remote-gateway`: integrates existing remote access provider(s).
- `packages/contracts`: versioned schemas for sessions, panels, anchors, capabilities, lifecycle actions.

## Key identity and model rules
- `sessionId`: stable backend identity, host- and boot-epoch aware.
- `panelId`: view placement identity; multiple panels can reference a session.
- `workspaceId`: saved layout namespace and human-readable project.
- `attachmentId`: viewer-to-session attachment; attach/detach is not start/stop.
- `homeAnchor`: saved tab group, split path, tab order, fallback workspace.
- `inputLease`: explicit exclusive write ownership with expiry and revocation.
- `hostId`: authenticated machine identity, separate from host display name.

## State vectors (not a single overloaded status)
- presentation: docked | focused | floating | detached | parked
- transport: connected | reconnecting | disconnected | unavailable
- process: starting | running | exited | failed | unknown
- recovery: none | reconnectable | relaunch-only | needs-user-action
Browser sessions use a separate renderer/document state and *must not* claim OS process durability.

## Data strategy
SQLite (control plane): projects, layouts, panel positions, connections without secrets, session metadata, audit metadata. Do not persist credentials, arbitrary terminal output, unredacted URLs containing tokens, or cookies here.
Host agent: own PTY handles and optional encrypted/bounded scrollback spool. A GUI crash leaves host agent alive; an agent crash does **not** guarantee PTY survival unless a supervisor/recovery mechanism is proven.
OS credential store/vault for secrets. No direct web access to raw keys.

## Protocol guidelines
- All commands idempotent when possible and include requestId/expected revision.
- Optimistic version checks on layout writes.
- Attach -> authorization -> input lease acquisition -> stream.
- Heartbeats with deadlines; lost connection never reclassified as exited without evidence.
- Origin-aware, authenticated WS; same rules for REST and socket.
- Dedicated host policy for permitted commands; no arbitrary remote `exec` API in MVP.
- Message size bounds, backpressure, rate limiting, output retention policies.

## Provider/browser compatibility
Desktop browser adapter may reuse live WebContentsView in one process; compatibility of moving between native windows requires spike. Browser UI uses normal provider pages when permitted; if framing/embedding fails, open isolated external browser. No shared cookies from desktop to browser companion.

## Security and packaging
Electron contextIsolation on, sandbox where supported, nodeIntegration off in remote content, strict navigation allowlists, limited IPC bridge. Browser remote requests must never access host-agent credentials. Control plane binds loopback by default and uses an authenticated private network route for remote clients.

## Open architecture questions
ADR-001: control plane on Windows vs Linux.
ADR-002: Windows PTY supervisor durability across GUI/client/agent crashes.
ADR-003: native view relocation and event/focus handling.
ADR-004: credential-store abstraction and Linux deployment.
ADR-005: output spool privacy, encryption, and quotas.
