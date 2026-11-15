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
- Electron binary `v45.3.2`
- `npm audit --omit=dev`: 0 vulnerabilities

Not yet claimed:

- The lab supervisor currently runs in Electron main, not a separately supervised host
  process; main-process crash survival is therefore unclaimed.
- Renderer reload/reconnect restoration is not yet demonstrated, although the main-process
  session ownership boundary is in place.
- No SQLite persistence or real terminal view is connected to the shell.
- No production packaging or code signing is configured.
