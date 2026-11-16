# Metadata Storage Spike

Status: implemented metadata prototype and desktop wiring | 2026-11-15

`@nexus/storage` uses Node 24's SQLite runtime for non-secret workspace, session, panel, and
launcher-profile metadata.
It persists stable IDs, host/process state, recovery markers, panel placement, home anchors,
and layout revisions. It intentionally has no terminal-output, cookie, token, credential, or
arbitrary URL columns.

Launcher profiles persist only an identifier/display name plus the executable kind, argument
array, and optional working directory. They have no environment, credential, token, cookie,
password, URL, or terminal-output fields. Profile arguments are still subject to the host-agent
allowlist and bounds; credential-shaped arguments such as `--token=...`, `--password=...`,
`--api-key=...`, and bearer values are rejected before persistence. Persistence does not grant
launch authority.

Validated:

- Schema creation and migration to `user_version = 3`, including v1 compatibility.
- Session and panel metadata survive closing and reopening the SQLite file.
- Workspace panel listing is deterministic.
- Storage tests inspect the actual SQLite column set and reject orphan panels.
- Prior supervisor epochs reconcile to `unknown` process state and `relaunch-only` recovery;
  no process survival across supervisor failure is claimed.
- Panel batch writes are transactional and roll back on foreign-key failure.
- Migrations now include a stable workspace registry ordered by display name and ID.
- Workspace deletion is explicit and rejects workspaces that still contain panels.
- Portable layout exchange belongs to the core adapter and exports only redacted panel placement
  metadata; session, surface, and window identity are not included.
- SQLite schema inspection verifies the profile column set and rejects secret-shaped columns.

Not yet implemented:

- Automatic relaunch of sessions after supervisor restart.
- Transactional layout command integration with the lifecycle processor.
- Encryption-at-rest policy and OS credential-store integration.
