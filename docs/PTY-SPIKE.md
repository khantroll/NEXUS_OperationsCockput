# Windows ConPTY Spike

Status: limited evidence | 2026-11-16

## Scope

`packages/host-agent` provides a renderer-independent `PtySupervisor` backed by
`node-pty` 1.1.0. It owns Windows ConPTY sessions, stable session IDs, bounded output
replay, attach/detach handles, read/write attachment modes, and explicit termination.

## Demonstrated

- Two independent command-shell sessions start with distinct session IDs and PIDs.
- Both emit stateful sequential output concurrently.
- Detaching both handles does not stop their processes.
- Reattaching returns bounded output replay and preserves the original PIDs.
- Read attachments cannot write input.
- Explicit termination reaches the observed `exited` state.
- Output replay is capped by a configured byte limit.
- Completed sessions can be explicitly disposed after attachments detach, releasing
  replay memory and the registry entry.

Run with:

```text
npm test
```

The focused host-agent tests are in
`packages/host-agent/test/supervisor.test.ts`.

## Limitations and unproven claims

- A minimal direct probe reproduced `AttachConsole failed` both when `node-pty` `kill()` was
  called after `onExit` and when it was used for forced termination while running. Omitting
  the kill avoided the diagnostic but did not produce a reliable PTY exit event, so that path
  was rejected as unsafe for cleanup.
- Renderer reload survival is demonstrated by the desktop smoke; supervisor-process crash,
  machine restart, and host-agent recovery remain separate claims.
- Supervisor-process crash, machine restart, and host-agent recovery have not been tested
  and must not be claimed.
- SQLite metadata and renderer lifecycle integration are implemented as M0 lab boundaries;
  durable PTY restart recovery and production attachment authorization remain unfinished.
- The cleanup diagnostic is isolated to node-pty's ConPTY process-list helper; explicit native
  cleanup is retained because alternatives tested here did not reliably signal PTY exit.
