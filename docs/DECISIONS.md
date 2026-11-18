# Architecture Decision Register
Each decision is **proposed** until backed by an executable spike or recorded approval.

| ID | Decision | State | Evidence needed |
|---|---|---|---|
| ADR-001 | Hybrid desktop-first control plane; locate the first service on the primary Windows host or Linux | Accepted for M0 planning (Windows-first lab) | broader connection/recovery tests |
| ADR-002 | Durable Windows PTY owner independent of GUI | Constrained: renderer-reload survival only | UI-crash and host-agent-crash experiments; supervisor still runs in Electron main |
| ADR-003 | Desktop windowing: Dockview was the original spike; Metro is now the chosen UI direction, with WebContentsView for provider pages | Direction changed; Dockview not adopted. Metro spike is on `main`; restore/preview/workspace follow-up in progress | WebContentsView dock/float/park tests |
| ADR-004 | SQLite non-secret metadata store | Accepted for M0/M1 (prototype + desktop wiring) | encryption-at-rest and OS credential-store integration |
| ADR-005 | Exclusive writer lease for shared terminals | Accepted for the in-process lab (unit tests) | two live desktop clients and disconnect races |
| ADR-006 | Private network for remote access plus app auth | Accepted for v0.1: loopback default, Tailscale/WireGuard for remote; public https is experimental and opt-in only | threat-model review before any public exposure |
| ADR-007 | Provider websites: compatible embedded view or external browser | Partial: top-level view loads; iframes refused; sign-in untested | per-provider sign-in and dock/float/park matrix |
| ADR-008 | The first host is a Windows workstation; Electron + React + TypeScript is the first desktop stack | Accepted for M0 | desktop shell and host integration spike |
| ADR-009 | Host-agent and persistent session supervisor are renderer-independent; cross-platform host ports are required | Accepted for M0 | supervisor lifecycle and Linux/macOS port interfaces |
| ADR-010 | Windows terminal sessions use ConPTY through a maintained PTY library, not a custom terminal emulator | Accepted for M0 | executable two-session ConPTY demonstration |
| ADR-011 | UI/panel survival is separate from supervisor/process survival; only demonstrated failure boundaries may be claimed | Accepted for M0 | renderer reload and supervisor-failure experiments |
| ADR-012 | Provider and remote integrations use independent adapters and supported APIs/browser flows; no security-header bypass or iframe assumption | Accepted for M0 planning | compatibility matrix for ChatGPT, Claude, Gemini, Codex, SSH, VNC, and RDP |

## Decision criteria
Prefer isolation and state correctness over seamless-looking animations; published capability matrix over untested promises; explicit operation permissions over unrestricted host agents.

## Accepted M0 constraints

- Terminal processes must survive panel transitions, renderer reloads, and UI disconnects
  once the supervisor spike proves that boundary. Supervisor-process or machine-failure
  survival remains unclaimed until separately implemented and tested.
- SQLite will hold non-secret session/layout metadata and recovery markers when the
  persistence milestone begins. Credentials, cookies, tokens, and personal session data
  are never stored in the repository or metadata database.
- The existing panel reducer remains the presentation boundary for Park, Summon, SnapBack,
  and Set Home. Layout restoration and session execution state are separate concerns.
- Remote and web providers are adapter-oriented. Unsupported embedding falls back to an
  external or supported browser integration; no provider security control is bypassed.

## Accepted M2 constraints (owner decisions, 2026-11-17)

- **Single-owner trust model.** The holder of the per-run companion enrollment token is fully trusted: one
  token may request any companion capability, and grants are per host rather than per client or per session.
  Ease of operation is preferred over multi-user authorization. Per-client/per-session grants are therefore
  deliberately not planned. Revisit only if the companion is ever shared with another person or exposed beyond
  loopback; the M2 "authorized terminal" exit criterion is read as "authorized by the owner's token".
- Safety limits that do not add operating friction stay: loopback-only binding, no generic exec route,
  user-only credentials file, bounded output, and no secrets in logs.
## Experiment log template
- Experiment and commit:
- OS / versions:
- Steps to reproduce:
- Observed sessionId/PID and renderer state:
- Result: passed / failed / limited:
- Security implications:
- Follow-up ADR change:
