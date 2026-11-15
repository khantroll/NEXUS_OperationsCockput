# Feasibility Matrix
No entries below are claimed as verified. Record test evidence with commit and environment.

| Scenario | Expected assertion | Status |
|---|---|---|
| PTY park -> summon -> SnapBack | same sessionId + host process | Not tested |
| Two CLIs running concurrently | isolated independent PTYs | Not tested |
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
