# Desktop Shell Spike

Status: build-validated laboratory shell | 2026-11-15

`apps/desktop` is the first Electron + React + TypeScript surface. Electron owns the
window and hardened preload boundary; Vite builds the React renderer. The renderer uses
the existing panel lifecycle reducer for local Park, Summon, and SnapBack controls.

The preload also exposes a narrow, read-only demo host bridge for starting or reattaching
to the main-process supervisor's demo session. It validates the renderer file origin and
session/attachment identifiers; it does not expose arbitrary command execution.
Workspace names are loaded and created through the same validated preload boundary and are
stored as non-secret SQLite metadata; the renderer still uses one deterministic default
workspace in this laboratory shell.
The session shelf also reads persisted non-secret session state so a relaunch-only record is
visible without implying that its prior process is still alive.
Terminal input is opt-in: renderer attachments default to read-only, only one write attachment
is allowed per session, and writes are bounded and owner-checked at the IPC boundary.

Validated:

- `npm run build --workspace @nexus/desktop`
- `npm run typecheck --workspace @nexus/desktop`
- `npm run smoke:reload --workspace @nexus/desktop`
- Reload smoke restores the renderer's persisted panel placement and revision, not just the
  main-process host session.
- Reload smoke continues to restore the panel while the workspace registry is initialized
  through SQLite-backed metadata.
- The session shelf lists persisted session identity and recovery state; it does not expose
  terminal output or provide unauthorised process control.
- Reload smoke verifies that a read-only attachment cannot submit terminal input.
- `npm run smoke:restart --workspace @nexus/desktop` verifies two-process reconciliation and
  relaunch with a new PID; it deliberately does not claim process survival across supervisor
  failure.
- Electron binary `v45.3.2`
- `npm audit --omit=dev`: 0 vulnerabilities

Not yet claimed:

- The lab supervisor currently runs in Electron main, not a separately supervised host
  process; main-process crash survival is therefore unclaimed.
- The shell now opens a per-user SQLite metadata database and records PTY lifecycle metadata;
  accepted panel transitions persist and reload through the validated layout bridge. Durable
  process survival across supervisor failure and a full terminal renderer remain out of scope.
- No production packaging or code signing is configured.
