# Windows ConPTY Spike

Status: limited evidence | 2026-11-15

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

- The current `node-pty` ConPTY cleanup path emits `AttachConsole failed` diagnostics
  from its process-list helper during explicit termination on this Windows environment,
  although the awaitable termination result reaches `exited` and tests return success.
  This is recorded as a cleanup limitation, not hidden as a clean result.
- Renderer reload survival has not been demonstrated because Electron is not implemented.
- Supervisor-process crash, machine restart, and host-agent recovery have not been tested
  and must not be claimed.
- SQLite metadata, durable restart recovery, renderer lifecycle integration, and production
  attachment authorization remain unfinished. The separate M0 integration test covers only
  reducer/host co-execution.
