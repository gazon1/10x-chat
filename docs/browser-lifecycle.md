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

A session creation stays registered until the browser settles it — not until the bound of the operation expires. A creation that outlasts its bound is still running inside the browser: a daemon that counted it as finished would look idle while the browser is busy, and the switch would take the browser away from that session. The counter is released when the creation has settled *and* the call that started it is done, so a context that is neither registered nor idle never counts as idle.

## The bounds of an RPC

Every dispatched browser operation follows one contract (`src/browser/operation-timeout.ts`):

- **The bound of the operation** — the bound the caller asked for (the `timeout` option of Playwright) plus a margin, or the default bound of the service (60 s) when the call names no bound. Every blocking operation is wrapped with it, whatever the method is: a `locator.click` waits no longer than a `page.goto`.
- **The bound of the RPC** (180 s, or the bound of the operation plus a margin) — the final boundary of the call. It is above the bound of the operation, so the operation reports its own timeout first.
- **The bound of the client** — the bound of the RPC plus a margin. The client waits longer than the server: the server answers a hung call with an error, and the client has to be able to read that answer. Both sides derive the bounds from the same request, so the client never cuts a long wait of the caller short.

An operation that does not answer in time may still run inside the browser: the session of the operation (the page, or the context without a page) is invalidated — the handle is refused from now on, so a later operation cannot work on a half-changed page. A context or a page that arrives after its bound is closed instead of being registered: nobody learns its id.

The bound of the caller is read from the options argument of the call and from nowhere else — the declaration in `src/browser/operation-timeout.ts` (`DISPATCHED_METHODS`) names every dispatched method and the position of that argument, and the test in `tests/operation-timeout.test.ts` reads the dispatcher and fails when a method is dispatched and not declared. `waitForFunction` is the one that is easy to get wrong: its options are the third argument, the second one being the argument of the function.

A method that takes no bound of the caller may still declare a bound of its own (`boundMs` in the same table): the typing of a prompt is one keystroke per character, and a chunk of a long prompt took 70–80 seconds — the default bound of 60 seconds killed calls that used to answer in time. The declared bound of the method is used by the server and by the client, so both sides wait for the same time.

## Ownership and cleanup

- Each caller owns the returned `BrowserSession` and must `await close()` (orchestrators/CLI do this in `finally`).
- Shared daemon contexts are owned by the daemon server until closed via RPC; `BrowserSession.close()` performs best-effort storage-state save + page/context close.
- Persistent contexts own their profile lock for the session lifetime; lock release happens after context close/export.
- CLI process handlers clean up the browser resources this process owns or is opening on SIGINT/SIGTERM/uncaughtException. The shared daemon is stopped only through its safety barrier (`requestDaemonStop`), so a command that never opened a browser and another invocation's session are never affected. Explicit administrative shutdown keeps its documented semantics.

## Diagnostics

- Runtime errors from launch/orchestration are wrapped with structured context: `provider`, `operation`, `stage`, sanitized `url` (no query/hash/userinfo), and `elapsedMs`.
- Sensitive values are redacted from diagnostic text and sanitized error cause chains (authorization/cookie/token/secret/password/prompt/session-like fields and local home paths), on a best-effort basis.
- Opt-in debug mode: set `TEN_X_CHAT_BROWSER_DEBUG=1` to capture local debug artifacts for persistent sessions on launch/close failures under `~/.10x-chat/debug/<timestamp>-<provider>-<operation>/` (`meta.json`, `events.json`, `screenshot.png`, `page.html`, `trace.zip`). These artifacts may contain private/sensitive data (page content, screenshots, form values, account details) and must be treated as sensitive; cookies/storage-state dumps are not written, and known secret patterns are best-effort redacted in text/events/HTML but removal is not guaranteed.
