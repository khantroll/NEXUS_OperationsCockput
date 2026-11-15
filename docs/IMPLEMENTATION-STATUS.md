# Implementation Status

Status: M0 implementation in progress | 2026-11-15

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
- `npm test` (13 passing tests)

## Next unfinished work

1. Add persistence-free lifecycle failure/recovery tests and durable replay retention.
2. Add the executable host-agent/PTY spike and record its results in the feasibility matrix.
3. Add CI and only then begin the Electron shell spike.

The current reducer records presentation state only. It does not yet resolve an anchor
against a persisted layout, clamp missing displays, or provide durable session, Electron,
or remote-connection behavior; those remain unimplemented M0 experiments.
