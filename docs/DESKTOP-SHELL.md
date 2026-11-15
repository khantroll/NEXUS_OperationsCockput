# Desktop Shell Spike

Status: build-validated laboratory shell | 2026-11-15

`apps/desktop` is the first Electron + React + TypeScript surface. Electron owns the
window and hardened preload boundary; Vite builds the React renderer. The renderer uses
the existing panel lifecycle reducer for local Park, Summon, and SnapBack controls.

Validated:

- `npm run build --workspace @nexus/desktop`
- `npm run typecheck --workspace @nexus/desktop`
- Electron binary `v45.3.2`
- `npm audit --omit=dev`: 0 vulnerabilities

Not yet claimed:

- No host-agent IPC is exposed through preload.
- No renderer reload/reconnect restoration is implemented.
- No SQLite persistence or real terminal view is connected to the shell.
- No production packaging or code signing is configured.
