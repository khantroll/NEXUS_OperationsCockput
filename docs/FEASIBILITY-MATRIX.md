# Feasibility Matrix
Entries below are evidence-backed only to the extent stated in their status; limited rows
must not be read as full product acceptance. Record test evidence with commit and environment.

| Scenario | Expected assertion | Status |
|---|---|---|
| PTY park -> summon -> SnapBack | same sessionId + host process | Limited: host attach/detach/replay passed; panel integration not tested |
| Two CLIs running concurrently | isolated independent PTYs | Passed in host-agent spike; 2 sessions, distinct PIDs |
| Explicit PTY termination | process exits and UI can mark exited | Limited: observed exited; node-pty emits cleanup diagnostics |
| GUI process crash | host-managed PTY remains attachable | Not tested |
| Host agent crashes | honest status and documented survival | Not tested |
| Browser view dock -> float in same window | JS counter and scroll unaffected | Not tested |
| Browser view -> detached native window | measure JS/cookie/page preservation | Not tested |
| Browser view parked -> summoned | same renderer if alive | Not tested |
| GUI crash -> browser recovery | restore URL/profile; no unearned state claim | Not tested |
| Second monitor disconnected | clamp window onscreen | Not tested |
| Two clients attempt writing | one input lease only | Not tested |
| Network interruptions | reconnect without duplicate process | Not tested |
| Provider ChatGPT/Claude/Gemini | authentication, navigation and policy compatibility | Not tested |

## Test instrumentation
Log requestId, sessionId, attachmentId, panelId, windowId, host boot epoch, PID, and layout revision. Do not log secrets, prompts, authentication cookies, or sensitive terminal output by default.
