# Desktop Shell Spike

Status: build-validated laboratory shell | 2026-11-15

`apps/desktop` is the first Electron + React + TypeScript surface. Electron owns the
window and hardened preload boundary; Vite builds the React renderer. The renderer uses
the existing panel lifecycle reducer for local Park, Summon, and SnapBack controls.

The preload also exposes a narrow, read-only demo host bridge for starting or reattaching
to the main-process supervisor's demo session. It validates the renderer file origin and
session/attachment identifiers; it does not expose arbitrary command execution.

Validated:

- `npm run build --workspace @nexus/desktop`
- `npm run typecheck --workspace @nexus/desktop`
- `npm run smoke:reload --workspace @nexus/desktop`
- Electron binary `v45.3.2`
- `npm audit --omit=dev`: 0 vulnerabilities

Not yet claimed:

- The lab supervisor currently runs in Electron main, not a separately supervised host
  process; main-process crash survival is therefore unclaimed.
- The shell now opens a per-user SQLite metadata database and records PTY lifecycle metadata;
  durable process survival across supervisor failure and a full terminal renderer remain out of scope.
- No production packaging or code signing is configured.
