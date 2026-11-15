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

## Decision criteria
Prefer isolation and state correctness over seamless-looking animations; published capability matrix over untested promises; explicit operation permissions over unrestricted host agents.

## Experiment log template
- Experiment and commit:
- OS / versions:
- Steps to reproduce:
- Observed sessionId/PID and renderer state:
- Result: passed / failed / limited:
- Security implications:
- Follow-up ADR change:
