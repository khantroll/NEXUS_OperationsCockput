# Security Boundary and Threat Model (Preliminary)

## Assets
Local CLI sessions with filesystem access; remote SSH/RDP/VNC; provider sessions and cookies; repo tokens; terminal output; remote host credentials; saved workspaces.

## Trust boundaries
1. Electron remote web content is untrusted; no Node access or broad IPC.
2. Desktop UI is not the host agent; only a restricted authenticated protocol controls privileged actions.
3. Remote web user is not automatically authorized for host actions.
4. Third-party provider website login is not our credential store.
5. Agents (Tank/Conclave/OpenMausBot) cannot type in a human-controlled terminal without explicit, narrow authorization.

## Threats and mitigations
- Cross-site / renderer compromise -> sandbox, contextIsolation, disable nodeIntegration, URL/navigation allowlists, restricted preload, IPC validation.
- CSRF/WS hijack -> authenticated WS, origin validation, anti-CSRF controls, secure cookies, TLS.
- Exposed host agent -> bind loopback by default, authenticate peer identity, overlay-only remote ingress, firewall policy.
- Input injection / privilege abuse -> capability model, allowlisted launcher profiles, exclusive input lease, approvals for destructive commands.
- Secret leakage in state/output -> never store cookies/tokens in SQLite; redact sensitive logs; encrypted secrets vault; opt-in output archives with bounded retention.
- Session theft -> short-lived session tokens, rotation/revocation, strict attachment ACLs, session owner identity.
- Unsafe file uploads -> sandbox, size restrictions, explicit destination mapping.
- Browser remote content navigation -> default-deny host integrations; no arbitrary protocol handlers.
- Supply chain -> pin dependencies, lockfile, CI checks, code review and release signing.
- Availability -> heartbeat/timeouts, capped buffers, restart/recovery states and process cleanup.

## Deployment default
Private/single-user. No public admin endpoint, no default-password credentials, no open SSH/RDP/VNC ports, no hardcoded API keys. Use Tailscale/WireGuard or equivalent private network; still require application auth and authorization.

## Deferred
External security review and penetration testing before connecting production assets or allowing agent-directed host control.

## Public repository caution
This repository is public. Never commit real hostnames, addresses, infrastructure inventory, keys, auth cookies, production incident details, or screenshots containing secrets.
