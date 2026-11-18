# Feasibility Matrix
Entries below are evidence-backed only to the extent stated in their status; limited rows
must not be read as full product acceptance. Record test evidence with commit and environment.

| Scenario | Expected assertion | Status |
|---|---|---|
| PTY park -> summon -> SnapBack | same sessionId + host process | Passed in host integration and desktop renderer reload smoke; not tested across a GUI/main-process crash |
| Two CLIs running concurrently | isolated independent PTYs | Passed in host-agent spike; 2 sessions, distinct PIDs |
| Explicit PTY termination | process exits and UI can mark exited | Passed; node-pty's ConPTY process-list helper can still emit AttachConsole during dispose. The supervisor installs a fork guard so that helper does not fail `node --test` |
| GUI process crash | host-managed PTY remains attachable | Not tested |
| Host agent crashes | honest status and documented survival | Not tested |
| Browser view dock -> float in same window | JS counter and scroll unaffected | Not tested |
| Browser view -> detached native window | measure JS/cookie/page preservation | Not tested |
| Browser view parked -> summoned | same renderer if alive | Not tested |
| GUI crash -> browser recovery | restore URL/profile; no unearned state claim | Not tested |
| Second monitor disconnected | clamp window onscreen | Not tested |
| Two clients attempt writing | one input lease only | Passed in the in-process session registry unit tests; not tested with two live desktop or companion clients |
| Network interruptions | reconnect without duplicate process | Not tested |
| Provider ChatGPT/Claude/Gemini: load as a top-level Electron `WebContentsView` | page loads and shows its sign-in UI | Limited: passed for all three, logged out (2026-11-17, Electron 45.3.2, see Provider probe) |
| Provider ChatGPT/Claude/Gemini: embed in an iframe | page renders inside our page | Failed by design: all three refuse framing (see Provider probe); use a top-level view or the external browser |
| Provider sign-in completes inside the embedded view | login succeeds and session persists | Not tested (needs the owner's accounts; Google may reject embedded browsers) |

## Test instrumentation
Log requestId, sessionId, attachmentId, panelId, windowId, host boot epoch, PID, and layout revision. Do not log secrets, prompts, authentication cookies, or sensitive terminal output by default.

## Provider probe (2026-11-17)
Loaded each site's public page in a hidden Electron 45.3.2 `WebContentsView` with an in-memory session and the default user agent, no login, no header changes. Throwaway script; nothing persisted.

| Provider | Top-level view | Framing headers | In an iframe |
|---|---|---|---|
| ChatGPT (chatgpt.com) | 200; "Log in / Sign up" UI rendered | `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'` plus three browser-extension origins | `ERR_BLOCKED_BY_RESPONSE` |
| Claude (claude.ai/login) | 200; Google/Apple/email sign-in UI rendered | CSP `frame-ancestors 'self'` (`'none'` when framed) | `ERR_BLOCKED_BY_RESPONSE` |
| Gemini (gemini.google.com) | 200; landing page with Sign in rendered | `X-Frame-Options: DENY` | `ERR_BLOCKED_BY_RESPONSE` |
| Google sign-in (accounts.google.com) | 200; identifier page rendered | `X-Frame-Options: DENY` | HTTP 401 error page |

Conclusions, per the stop/go rule (never bypass provider security headers): provider pages must be hosted as top-level views (`WebContentsView`/window), never iframes. No bot challenge appeared. Whether sign-in completes is untested; if Google rejects the embedded browser, use the external-browser launch mode for Gemini (and for "Continue with Google" on the others) rather than altering the user agent.
