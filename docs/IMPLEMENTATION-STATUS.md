# Implementation Status

Status: M0 acceptance complete; M1 implementation in progress | 2026-11-15

The current architectural decisions are recorded in `docs/DECISIONS.md` (ADR-008 through
ADR-012). They are accepted constraints for this milestone, not evidence that the related
runtime behavior is already implemented.

## Recovered baseline

- `main` contained only the repository initialization commit.
- `design/architecture-roadmap-v0.1` is now the base for `feature/m0-foundation`.
- The design branch supplied the product requirements, architecture, security boundary,
  SnapBack lifecycle contract, feasibility matrix, roadmap, and type-only contracts.
- No application shell, host agent, persistence layer, CI, or lifecycle implementation
  existed at recovery time.

## Completed in this slice

- Added a TypeScript workspace foundation with strict typechecking and reproducible scripts.
- Added `@nexus/contracts` and `@nexus/core` package boundaries.
- Implemented a pure panel presentation reducer for Park, Summon, SnapBack, and Set Home.
- Enforced optimistic revision guards and idempotent repeated presentation commands.
- Added a command-boundary processor for authorization and request-id replay; the pure
  reducer remains reusable without process or storage dependencies.
- Added an in-memory session registry primitive for attachment lifecycle and one-writer
  input leases, with explicit expiry and detach revocation.
- Added a Windows-first `node-pty` host-agent spike with two-session concurrency,
  bounded replay, attach/detach, read/write modes, and explicit exit observation.
- Added a live integration demonstration connecting the panel reducer to a ConPTY session:
  Park → Summon → SnapBack preserves session ID, PID, and bounded replay without duplication.
- Added deterministic SnapBack anchor resolution for missing groups and displays, including
  explicit fallback markers without mutating persisted layout state.
- Added a minimal hardened Electron/React desktop shell with local lifecycle controls;
  build/typecheck and dependency audit pass. See `docs/DESKTOP-SHELL.md`.
- Added a narrow preload host bridge for demo-session start/status/attach/detach and bounded
  output events. It is origin- and identifier-validated; the supervisor still runs in the
  Electron main process for this lab and is not claimed durable across main-process failure.
- Added renderer-load auto-reconnect and an Electron smoke harness that reloads the renderer
  and verifies stable session ID/PID plus replay from the main-process supervisor.
- Added `@nexus/storage` SQLite metadata prototype with session/panel schema, reopen recovery,
  deterministic workspace listing, and no secret/output fields.
- Added the persistent workspace registry with deterministic name/ID ordering, explicit empty-only
  deletion, and a tested v1-to-v2 migration that preserves session and panel metadata.
- Added a read-only session shelf bridge that lists persisted session process, transport, and
  recovery states without exposing secrets or terminal output.
- Added non-secret Claude Code/Codex/shell profile contracts and an allowlisted host-agent
  resolver with absolute-workdir and bounded-argument validation.
- Added explicit desktop attachment modes and an owner-checked, bounded write bridge; read-only
  renderer attachments remain the default and only one writer is allowed per session.
- Added an optional supervisor metadata sink that records local PTY start/exit lifecycle state
  without making the supervisor or SQLite process a claim of crash survival.
- Wired the desktop host to a per-user SQLite database, reconcile prior supervisor epochs as
  `unknown`/`relaunch-only`, and persist panel batches transactionally at the storage boundary.
- The processor fails closed without an explicit authorization policy. Request replay is
  process-local with a configurable bounded retention; durable storage and restart recovery
  still belong to the persistence milestone.
- Cached retries are re-authorized. If a request ID is evicted, the optimistic revision guard
  is the safety boundary against re-execution; callers must use unique request IDs.
- Kept lifecycle transitions independent of session/process execution; no transition can
  spawn or terminate a backend session.
- Added Node test coverage for state transitions, revision rejection, idempotency, and
  invalid command handling.

## Evidence

Validated locally on Windows with Node 24.21.0:

- `npm run typecheck`
- `npm test` (32 passing tests; serialized to avoid concurrent ConPTY cleanup races)
- Host-agent focused runtime demonstration: 2 independent ConPTY sessions, bounded replay,
  detach/reattach, and exit observation passed; cleanup diagnostics remain documented in
  `docs/PTY-SPIKE.md`.
- Panel/host integration and Electron reload/reconnect smoke demonstrations passed; the
  smoke harness preserved session ID/PID, replay, and a parked panel's placement/revision
  across renderer reload.
- Desktop restart/recovery smoke passed in two Electron processes: the second process
  reconciled the prior PTY as `unknown`/`relaunch-only` and launched a new PID under the same
  stable session ID. This does not claim PTY survival across supervisor failure.
- GitHub Actions Windows validation passed for commit `327e977`: install, typecheck, 26 tests,
  desktop build/reload/restart smoke, and production audit.
- The explicit two-panel/two-PTY lifecycle acceptance test passes locally and in Windows CI with
  27 total tests.
- The workspace registry and v1-to-v2 metadata migration tests pass locally with 29 total tests.
- The session shelf listing and desktop reload smoke pass locally with 30 total tests.
- The shell profile launch boundary passes a live supervisor test; Claude/Codex executable
  availability is not claimed until those tools are installed in the target host environment.
- Desktop reload smoke also verifies that read-only input is rejected at the IPC boundary.

## Remaining limitation

1. Keep the isolated node-pty ConPTY cleanup diagnostic documented until an upstream-safe
   suppression or replacement is validated.

The current reducer records presentation state only. It does not yet resolve an anchor
against a persisted layout, clamp missing displays, or provide durable session, Electron,
or remote-connection behavior; those remain unimplemented M0 experiments.
