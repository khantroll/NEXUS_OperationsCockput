# Development Roadmap
Status: M0 and M1 accepted with documented gaps; Metro cockpit is in progress on top of `main`; M2 in progress.
Milestones are gated on verified evidence, not calendar estimates.

## M0 — Foundation and feasibility [COMPLETE, with documented gaps]
- Define package boundaries and threat model; TypeScript monorepo, formatting/lint/typecheck and Windows/Linux CI.
- Electron + React laboratory shell with Park/Summon/SnapBack and layout serialize/restore. Dockview was not adopted; Metro is the chosen UI and a first spike is on `main`.
- Host-owned Windows ConPTY proof: 2 PTYs, session registry and attach/detach; process survives **renderer reload**, not a GUI/main-process crash (supervisor still runs in Electron main).
- Browser renderer proof: regular test page + live counter + scroll state, move/park/undock across native windows; publish compatibility matrix.
- ADRs for ambiguous technical choices. No credentials or production hosts required.
**Exit:** executable laboratory + automated lifecycle evidence and documented limitations.

## M1 — Useful local cockpit [COMPLETE]
- Workspace navigation; projects; session shelf; keyboard Summon/SnapBack and Set Home.
- Stable IDs, layout revisioning, SQLite storage, recovery and process states.
- Claude Code/Codex CLI profile launchers with configurable workdir (no secrets in config).
- Scrollback quotas, interrupt/restart/stop confirmation, status and recovery UI.
- Portable import/export of **redacted** layout metadata.
**Exit:** operate two real agent terminals while moving/parking windows and restarting desktop UI with no duplicate processes.

## M2 — Trusted remote companion [IN PROGRESS]
- M2.0 capability boundary: added a deterministic provider registry for ChatGPT, Claude, Gemini,
  Codex, SSH, VNC, and RDP launch modes. It stores only non-secret capability metadata; no
  credentials or connection targets are accepted. This is not remote access or authentication.
- M2.1 enrollment policy: added an in-memory host enrollment/revocation primitive that generates
  high-entropy tokens and stores only salted scrypt hashes plus public host metadata. This is not
  yet a network API, durable vault, or private-network transport.
- M2.2 companion policy: added a policy-only private-network authorization boundary with bounded
  read capabilities (`read-workspace`, `attach-read`). It rejects public-network requests and
  invalid credentials, and exposes no generic exec or session-write capability. Transport/API
  implementation remains unfinished.
- M2.3 companion transport: added a loopback-bound HTTP endpoint for health and authenticated
  bounded-read authorization. It derives private scope from the socket, caps JSON bodies, sends
  no CORS or credential data, rate-limits authorization attempts, and does not expose session
  execution. LAN/private-network ingress, TLS/proxy identity, and durable service deployment
  remain unfinished.
- M2.4 read-only companion resource: short-lived grants can retrieve injected session metadata
  through a loopback endpoint. The endpoint exposes no terminal output, input, write lease, or
  generic execution.
- M2.5 persisted read model: `createMetadataReadModel` adapts the SQLite session metadata to the
  companion read model, scoped per host and limited to id/kind/process/transport (no PID, epoch,
  exit code, or recovery detail). It serves persisted metadata only; live supervisor push remains
  unfinished.
- M2.6 desktop companion: the desktop app starts the loopback-only read-only companion on launch
  (not in smoke runs) with a fresh single-user enrollment per run. The token is shown once in the
  session shelf (copy button) and written to `companion-credentials.json` in the app's userData
  directory; any existing file is replaced (links refused), the new file is created exclusively and empty,
  restricted to the current user by SID with `icacls` (0600 elsewhere), the ACL is read back (only that user,
  SYSTEM and Administrators may appear, since an elevated token adds them and they can take ownership anyway), and only
  then is the token written; if confirmation fails nothing is written. Residual risk: a process that
  opened the empty file before restriction could keep its handle. The token is in-memory and
  valid for that run only; it is never logged. Still loopback only: no LAN access, TLS, durable
  tokens, or live supervisor push.
- Authenticated, private-network-only web client and API; host enrollment and revocation.
- Linux host agent, tmux-backed sessions, SSH profile management, input leases.
- Guacamole integration spike for VNC/RDP; remote status, connection errors and observability.
- Browser provider matrix for ChatGPT/Claude/Gemini (native, external fallback, auth UX).
- M2.7 tmux backend: `TmuxBackend` (packages/host-agent/src/tmux.ts) owns sessions in a dedicated tmux server
  (`tmux -L nexus-cockpit`, tmux >= 3.0, argv-only, no shell) so they survive a supervisor/desktop restart; it can
  start, list (with exit codes via remain-on-exit), capture bounded scrollback, send literal input,
  interrupt, and idempotently kill, and maps survivors to `reconnectable` records. It is not yet wired into
  the desktop host, the companion, or profile launching, and input authorization/leases stay with callers.
  tmux treats any argument ending in `;` as a command separator and runs a lone command argument through
  `sh -c`; both were reproduced against real tmux during review, so `start` refuses `;`-terminated
  file/args/cwd, wraps a lone command in `env --`, and sends trailing `;` input as hex bytes. Regression
  tests cover each. Validated with real tmux 3.6a (an MSYS build run from Windows). A `linux-tmux` CI job
  is configured but has not run yet, so nothing is verified on a native Linux host.
- M2.8 read-only attach: with an `attach-read` grant (distinct from `read-workspace`) a loopback client can
  GET `/v1/companion/hosts/<host>/sessions/<id>/output` for the last 64 KiB of a session's terminal output
  (any session the supervisor still holds on that host, including exited ones not yet disposed), served from
  a read-only supervisor attachment. There is no input or exec route (POST is 404). The
  endpoint is off unless an output source is configured, and terminal output may contain sensitive text.
  Authority caveat: `attach-read` is a separate grant type, not a separate credential. Whoever holds the
  per-run enrollment token can request either capability, and grants are per host, not per session. That
  matches the single-user model (you are the only token holder) but is not yet per-client/per-session
  authorization, so this does not by itself close the M2 exit criterion for multi-user use. `truncated`
  reports only the HTTP-layer cut, not output the supervisor already dropped from its 64 KiB buffer.
  Still loopback-only, polling (no streaming), Windows desktop sessions only; tmux sessions are not exposed.
- M2.9 SSH profiles: `resolveSshProfile` (packages/host-agent/src/ssh-profile.ts) validates non-secret SSH
  profiles (host or ~/.ssh/config alias, user, port, key-file path, optional remote tmux session) and resolves
  them to an argv-only `ssh` invocation: host-key checking is never disabled, nothing may start with `-`, and
  authentication stays with ssh (agent, key, or prompt in the PTY). Windows uses the OS OpenSSH by absolute
  path. Wired to a profiles file, IPC and UI in M2.10.
- M2.10 interactive terminals and SSH UI: profile panels now use xterm.js (keyboard input over a write
  attachment, paste chunking, resize that follows the pane via a new `PtySupervisor.resize`), with a
  read-only fallback if another view already holds the writer. A "Launch shell" button was added. SSH
  profiles live in a user-editable `ssh-profiles.json` in the app's userData folder; the shelf lists them as
  one-click Connect buttons, reports bad entries without losing good ones, and has Edit/Reload buttons. The
  renderer sends only a profile ID; the main process builds the `ssh` argv from the validated file.
  Verified by driving the real app over the DevTools protocol (typed input echoed and executed; the PTY
  followed the pane width; SSH profile launched ssh in a PTY). Not verified against a live SSH server.
  Review fixes: a page reload releases its write attachments (so recovered terminals stay writable), output
  arriving before a terminal mounts is buffered and flushed in order, resize is keyed to the caller's own
  writable attachment, pastes are sent through one ordered queue in surrogate-safe chunks, and the profiles
  file is capped at 256 KB.
- M2.11 panel controls: every panel (including SSH) now has Interrupt, Terminate and Close; Restart remains
  for profile panels only (an SSH panel is reconnected with its Connect button). Close stops a running session,
  releases the view and removes the panel, and also works on exited panels. Verified over the DevTools protocol.
- M2.12 reachability modes (owner decision: all three must be possible). `companion-network.json` in the app's
  userData folder selects: `local` (default, loopback only), `private` (plain HTTP bound to one private address
  for a Tailscale/WireGuard/LAN interface; with no `bind` the machine's Tailscale 100.64.0.0/10 address is
  auto-detected; peers outside private ranges are refused), or `https` (experimental, outside v0.1 non-goals: TLS using your `certFile`/`keyFile` and a
  `publicHost` name, for exposure beyond a private network). `https` is accepted from `companion-network.json` only
  when `"experimentalPublicHttps": true` is also set; otherwise the desktop falls back to local with a warning.
  Any peer may connect in this mode, but the token and per-source rate
  limits still gate every request. Default remains loopback; the supported remote path is private/Tailscale. Hardening from the security review: a global auth-attempt ceiling applied
  before the expensive token hash (IPv6 sources grouped by /64), per-source connection caps, short handshake/header
  timeouts, disallowed peers dropped at connect time, fixed error text. `private` mode refuses plain-LAN binds
  (10.x/192.168.x/172.16-31.x) unless `"allowLan": true`, because the token would cross the LAN unencrypted;
  WireGuard users on such addresses set that flag. Do not front `local`/`private` mode with a public tunnel or
  reverse proxy (peers would look local/private); use `https` mode for public exposure. An invalid or
  unstartable config falls back to `local` with a visible warning, so a typo can never widen exposure. Changes
  apply on restart. Verified with unit tests (including a real TLS handshake) and by launching the real app in
  each mode (auto-detected this machine's Tailscale address). Not verified: a client on another machine.
- M2.13 provider probe: ChatGPT, Claude and Gemini all load and render their sign-in UI in a top-level Electron view and all refuse iframes; see the Provider probe in FEASIBILITY-MATRIX.md. Sign-in inside the view is untested.
**Exit:** remote client attaches to existing authorized terminal without exposing generic unauthenticated exec.

## Mx — Extract the host supervisor from Electron main [PLANNED]
- Move PTY ownership into a process (or service) that can outlive the desktop GUI.
- Prove attach after a **GUI / main-process crash**, not only after a renderer reload.
- Until then, recovery after a desktop restart stays `unknown` / `relaunch-only`. Do not claim PTY survival across a GUI crash.
**Exit:** a documented experiment showing the same session ID and PID after a deliberate GUI/main crash, or an explicit decision to keep relaunch-only.

## Metro cockpit [IN PROGRESS]
- The first Metro spike is on `main`: a workspace switcher over the real registry, a live tile grid, a parked shelf, and per-window SnapBack. It does not seed concept names (Conclave/Tank/Home Lab) or add Dockview/native pop-out.
- Restore gesture (decided): double-click on a parked tile is primary. A per-tile Restore button, and a right-click context action on that same tile, is the accessible secondary. There is no restore-all.
- Parked live previews: throttled snapshots of the terminal text buffer (default 3s, configurable via `NEXUS_METRO_PREVIEW_INTERVAL_MS`), paused when the window is hidden or minimized, with a concurrency cap (`NEXUS_METRO_PREVIEW_CONCURRENCY`, default 2) and a static last-snapshot fallback. This is not a live xterm in every parked tile, and it is not `webContents.capturePage` (deferred until browser/WebContentsView panels exist). Set `NEXUS_METRO_PREVIEW_TRACE=1` to log capture timings.
- Workspaces: File > New Workspace... (Ctrl/Cmd+Shift+N) prompts for a name; dragging a live or parked tile onto the switcher moves it into that workspace; dropping onto the New workspace target prompts for a name and creates a workspace containing that panel. Creates and moves persist through the existing SQLite workspace/panel registry. Rename and empty-workspace delete UI are not in this slice.
- Usable daily path: `npm run desktop` (and `npm start --workspace @nexus/desktop`) always rebuilds the renderer. The ipc-tick lab demo is not auto-started; smoke tests use a temporary userData directory. Live panels are xterm sessions only. The session shelf hides exited/unknown/relaunch-only rows by default, with a Show exited toggle, Clear exited, and Clear lab/demo sessions. Session names come from the profile label and cwd. New Terminal, Claude, Codex, and SSH launchers stay in the header, and an empty workspace has a New Terminal call to action.
- Visual fidelity pass: the shell follows the concept image's regions — a top wordmark bar with LOCAL/clock, a left rail, a large active-workspace header, dark window-chrome live terminals that fill the space above a fixed bottom dock, and colorful parked tiles. Live xterm panes fit and wrap with the Fit addon and a ResizeObserver, and send cols/rows back to the PTY. Lab footer buttons are replaced by Metro title-bar controls (park, maximize, close, overflow). A read-only REPO tile lists the workspace git tree, last commit, and recent activity from a main-process allow-listed inspect (no shell string interpolation). Illustrated Docs/VS Code tiles are not seeded; typography and icons are closer but not pixel-identical.

## M3 — Project workspaces and integrations
- Project recall and context packages; GitHub overview, CI/status adapters.
- Read-only adapters: Conclave, Tank, OpenMausBot, Hail, AI Skills.
- Activity shelf notifications, logs with redaction and audit; selective handoff to agents.
**Exit:** switching projects preserves workspace/session semantics, no unintended cross-project permissions.

## M4 — Harden / release
- Fault injection (GUI/renderer/host/network), multi-monitor regression, accessibility, performance benchmarks.
- Packaging/updater signing, migration/backup/restore, secrets handling review.
- Documentation, installer, compatibility matrix, release checklist.
**Exit:** supported platforms and tested recovery behavior published.

## Sequenced issue backlog
1. ADR + threat model
2. Monorepo + CI + contracts
3. Metro layout spike (landed on `main`; follow-up: cheap parked previews and workspace create/move)
4. Host-owned ConPTY supervisor spike
5. WebContentsView persistence/reparent spike
6. SnapBack core state machine + tests
7. Workspace registry + SQLite
8. CLI profiles and resource telemetry
9. Web companion/auth/host enrollment
10. SSH/tmux + remote gateway integration

## Stop/go gates
- If native view reparenting loses live state, use a stable owning window/overlay in desktop and **explicitly** mark cross-window view as URL restoration, not seamless continuity.
- If Windows PTY cannot survive its owner crashing, introduce persistent supervisor/service or constrain guarantee to UI-crash survival; do not claim machine-reboot continuity.
- If provider web embeds fail, use external browser/open-url; never bypass provider security headers.
- No public exposure until threat-model review, authentication, revocation, logging, and secure config are verified.

## Definition of Done
Reproducible commands, tests, documented failure modes, security review for new privileged IPC, no fake live statuses, and PR linked to requirement/ADR. Empty checkboxes are not evidence of implementation.
