# NEXUS Operations Cockpit

A desktop-first, self-hostable operations workspace for persistent AI CLI terminals, web chat views, and remote infrastructure.

**Status: laboratory / pre-release.** A local Electron cockpit and a loopback or private-network companion are implemented. This is not production-ready session isolation or remote access. The host supervisor still runs in the Electron main process, so a GUI crash does not preserve PTYs (recovery is relaunch-only).

## Core promise
- **Summon:** bring an existing session to the foreground.
- **SnapBack:** return its presentation to a saved home anchor.
- **Park:** hide or minimize presentation *without* terminating its host-owned process.
- **Recover:** restore layout and reconnect to surviving sessions honestly, without fabricating continuity.

## Architecture
- Desktop: Electron + TypeScript + React. The Metro cockpit on `main` is the default shell (see `docs/design/operations-cockpit-metro-concept.md`). Visual fidelity to the concept image is still in progress.
- Web companion: browser UI for accessible backends, **not** migration of a local Chromium renderer. The current companion is an HTTP API (loopback by default; private/Tailscale for remote). There is no `apps/web` client yet.
- Control plane: session registry, policies, workspaces, connection metadata, events (in-process in the desktop lab).
- Host agents: own PTY and runtime processes on Windows/Linux.
- Remote gateway: integrate existing SSH/RDP/VNC solutions rather than implementing protocols.
- Storage: SQLite for non-secret workspace metadata; credentials in OS/key-vault-backed storage.

## Non-goals for v0.1
No autonomous agent control, no broad public internet exposure, no provider-website bypasses, no guarantee of browser session survival after renderer crash, and no production infrastructure connections. An experimental `https` companion mode exists in code but stays off unless `experimentalPublicHttps` is set in `companion-network.json`.

## Run the desktop app

From the repository root, after `git pull`:

```
npm install
npm run desktop
```

`npm run desktop` always rebuilds the Vite renderer and then starts Electron. A plain `git pull` does not update `apps/desktop/dist/` (it is gitignored), and `npm start --workspace @nexus/desktop` now rebuilds first for the same reason. Root `npm run build` only compiles the packages, not the desktop UI.

The app does not auto-start the lab `ipc-tick` demo session. Smoke tests (`npm run smoke:reload --workspace @nexus/desktop` and `smoke:restart`) use a temporary userData directory so they do not write into your real session database. Use **Clear lab/demo sessions** in the session shelf if an earlier build left demo rows in `%APPDATA%\\@nexus\\desktop\\nexus.sqlite` (Windows) or the corresponding userData path.

## Docs
See `docs/PRODUCT-REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/SNAPBACK-LIFECYCLE.md`, `docs/ROADMAP.md`, `docs/SECURITY.md`, and `docs/IMPLEMENTATION-STATUS.md`.

**Repository name:** the existing spelling `NEXUS_OperationsCockput` is preserved; the product name is **NEXUS Operations Cockpit**.
