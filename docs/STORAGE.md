# Metadata Storage Spike

Status: implemented metadata prototype | 2026-11-15

`@nexus/storage` uses Node 24's SQLite runtime for non-secret session and panel metadata.
It persists stable IDs, host/process state, recovery markers, panel placement, home anchors,
and layout revisions. It intentionally has no terminal-output, cookie, token, credential, or
arbitrary URL columns.

Validated:

- Schema creation and migration to `user_version = 1`.
- Session and panel metadata survive closing and reopening the SQLite file.
- Workspace panel listing is deterministic.
- Storage tests inspect the actual SQLite column set and reject orphan panels.

Not yet implemented:

- Host-agent reconciliation after supervisor restart.
- Transactional layout command integration with the lifecycle processor.
- Encryption-at-rest policy and OS credential-store integration.
