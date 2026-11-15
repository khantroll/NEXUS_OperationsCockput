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
- The processor fails closed without an explicit authorization policy. Request replay is
  process-local and intentionally unbounded only for this prototype; durable storage and
  retention limits belong to the persistence milestone.
- Kept lifecycle transitions independent of session/process execution; no transition can
  spawn or terminate a backend session.
- Added Node test coverage for state transitions, revision rejection, idempotency, and
  invalid command handling.

## Evidence

Validated locally on Windows with Node 24.21.0:

- `npm run typecheck`
- `npm test` (8 passing tests)

## Next unfinished work

1. Add a typed session registry boundary and explicit attachment/input-lease reducer.
2. Add persistence-free lifecycle failure/recovery tests and durable replay retention.
3. Add the executable host-agent/PTY spike and record its results in the feasibility matrix.
4. Add CI and only then begin the Electron shell spike.

The current reducer records presentation state only. It does not yet resolve an anchor
against a persisted layout, clamp missing displays, or provide durable session, Electron,
or remote-connection behavior; those remain unimplemented M0 experiments.
