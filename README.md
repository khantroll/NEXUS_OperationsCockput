# NEXUS Operations Cockpit

A desktop-first, self-hostable operations workspace for persistent AI CLI terminals, web chat views, and remote infrastructure.

**Status: design and feasibility phase. No production-ready session isolation or remote access yet.**

## Core promise
- **Summon:** bring an existing session to the foreground.
- **SnapBack:** return its presentation to a saved home anchor.
- **Park:** hide or minimize presentation *without* terminating its host-owned process.
- **Recover:** restore layout and reconnect to surviving sessions honestly, without fabricating continuity.

## Architecture
- Desktop: Electron + TypeScript + React with native WebContentsView where appropriate.
- Web companion: browser UI for accessible backends, **not** migration of a local Chromium renderer.
- Control plane: session registry, policies, workspaces, connection metadata, events.
- Host agents: own PTY and runtime processes on Windows/Linux.
- Remote gateway: integrate existing SSH/RDP/VNC solutions rather than implementing protocols.
- Storage: SQLite for non-secret workspace metadata; credentials in OS/key-vault-backed storage.

## Non-goals for v0.1
No autonomous agent control, no broad public internet exposure, no provider-website bypasses, no guarantee of browser session survival after renderer crash, and no production infrastructure connections.

## Initial work
See `docs/PRODUCT-REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/SNAPBACK-LIFECYCLE.md`, `docs/ROADMAP.md`, and `docs/SECURITY.md` on the design branch.

**Repository name:** the existing spelling `NEXUS_OperationsCockput` is preserved; the product name is **NEXUS Operations Cockpit**.
