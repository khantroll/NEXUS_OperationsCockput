# Architecture Decision Register
Each decision is **proposed** until backed by an executable spike or recorded approval.

| ID | Decision | State | Evidence needed |
|---|---|---|---|
| ADR-001 | Hybrid desktop-first control plane; locate service on Xenos or Linux | Proposed | connection/recovery tests |
| ADR-002 | Durable Windows PTY owner independent of GUI | Feasibility required | UI-crash + host-agent-crash experiments |
| ADR-003 | Dockview + Electron WebContentsView for desktop | Feasibility required | tab/popout continuity tests |
| ADR-004 | SQLite non-secret metadata store | Proposed | schema/migration prototype |
| ADR-005 | Exclusive writer lease for shared terminals | Proposed | race and disconnect tests |
| ADR-006 | Private network for remote access plus app auth | Proposed | security threat model |
| ADR-007 | Provider websites: compatible embedded view or external browser | Proposed | per-provider test matrix |
| ADR-008 | Windows/Xenos is first host; Electron + React + TypeScript is first desktop stack | Accepted for M0 | desktop shell and host integration spike |
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

## Experiment log template
- Experiment and commit:
- OS / versions:
- Steps to reproduce:
- Observed sessionId/PID and renderer state:
- Result: passed / failed / limited:
- Security implications:
- Follow-up ADR change:
