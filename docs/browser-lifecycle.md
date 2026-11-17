# Browser lifecycle

Single owner: `src/browser/manager.ts` (`launchBrowser`) creates and closes `BrowserSession` objects for all CLI/core flows.

## Modes

- **Shared non-persistent** (default chat/image/research/history/delegate/status checks): `manager` asks `daemon.ts` for a session. The daemon ensures one shared Chromium server process (`server.ts`, HTTP RPC, state in `~/.10x-chat/browser-daemon.json`), creates an isolated browser context loaded from `~/.10x-chat/profiles/default/storage-state.json`, and returns a page/context proxy. On close, storage state is exported back to the shared file and the remote page/context are closed. The daemon process exits on idle timeout or explicit stop.
- **Shared persistent** (`login` in shared mode): `manager` acquires the shared profile lock, launches a local persistent context in `profiles/default`, exports shared storage state on close, then releases the lock. Used for interactive login so cookies persist and can be reused by daemon sessions.
- **Isolated/named persistent** (`--isolated-profile`, `--profile <name>`): `manager` acquires the target profile lock, launches a local persistent context in `profiles/<name|provider>`, and releases the lock on close.

## Switching a running daemon

A daemon is only replaced when it does not fit the request (another headless mode or another proxy) and has no session of another process any more. The replacement runs through a barrier: the daemon stops accepting new sessions, waits for the running session creations, and reports what is left.

The answer of the barrier is read as three different states, because they are not the same:

- **switched** — the daemon reported its remaining work. Only this answer allows the daemon to be stopped.
- **unavailable** — nothing listens on the port: the daemon is really gone and a new one may start.
- **failed** — the daemon answered, but not with the result of the switch (unknown endpoint, refused request, unreadable body, incomplete answer). It may still serve the session of another process, so it is left running and the switch is refused.

A failed switch is never read as "the daemon is dead": a second daemon would take the state file away from the old one and break the session it still serves.

The answer of the barrier is only used when it is complete: `ok: true`, all three counters are finite non-negative numbers, and `drained` is a boolean. A missing counter would look like "no session" and a missing `drained` would look like "idle" — both would allow a daemon with a foreign session to be stopped.

## Ownership and cleanup

- Each caller owns the returned `BrowserSession` and must `await close()` (orchestrators/CLI do this in `finally`).
- Shared daemon contexts are owned by the daemon server until closed via RPC; `BrowserSession.close()` performs best-effort storage-state save + page/context close.
- Persistent contexts own their profile lock for the session lifetime; lock release happens after context close/export.
- CLI process handlers stop the daemon on SIGINT/SIGTERM/uncaughtException to avoid orphaned browser processes.

## Diagnostics

- Runtime errors from launch/orchestration are wrapped with structured context: `provider`, `operation`, `stage`, sanitized `url` (no query/hash/userinfo), and `elapsedMs`.
- Sensitive values are redacted from diagnostic text and sanitized error cause chains (authorization/cookie/token/secret/password/prompt/session-like fields and local home paths), on a best-effort basis.
- Opt-in debug mode: set `TEN_X_CHAT_BROWSER_DEBUG=1` to capture local debug artifacts for persistent sessions on launch/close failures under `~/.10x-chat/debug/<timestamp>-<provider>-<operation>/` (`meta.json`, `events.json`, `screenshot.png`, `page.html`, `trace.zip`). These artifacts may contain private/sensitive data (page content, screenshots, form values, account details) and must be treated as sensitive; cookies/storage-state dumps are not written, and known secret patterns are best-effort redacted in text/events/HTML but removal is not guaranteed.
