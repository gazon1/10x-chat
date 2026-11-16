# Production-readiness harness (issue #13)

Isolated harness that compares the current production browser runtime
(CloakBrowser / Chromium) with Camoufox (Firefox) **before** any migration.
It does not touch production code: it talks to both engines through the same
adapter, so every scenario runs identically on both.

## Layout

| File | What it does |
|------|--------------|
| `engines.mjs` | Adapter for both engines (`launch`, `launchPersistent`) |
| `util.mjs` | Check runner, report writer, process/RSS helpers, version capture |
| `proxy-matrix.mjs` | HTTP(S)/SOCKS5 (no auth / RFC 1929 auth), bypass list, env vars, credential leakage |
| `lifecycle-matrix.mjs` | Persistent profile reuse, context isolation, `storageState`, upload/download, browser reuse, cleanup |
| `ops-matrix.mjs` | Install footprint, cold/warm start, RSS, leftover processes, licensing facts |
| `provider-matrix.mjs` | 5 providers × (10 runs, 30 for Cloudflare-dependent) × 2 engines + authorized round-trip (5 × 2 combinations, with a session-reuse check) |
| `round-trip.mjs` | state of the round-trip criterion (which combinations passed) |
| `report-compat.mjs` | when a saved report may be reused (`SPIKE_REUSE=1`) |
| `socks5-relay.mjs` | **Experiment only**: local SOCKS5 adapter that authenticates upstream (cost assessment, not a production path) |
| `run-all.mjs` | Runs every matrix in sequence and writes `results/summary.json` |

The proxy and fixture servers are reused from the 3/8 spike
(`spike/camoufox/proxies.mjs`, `spike/camoufox/fixtures.mjs`) so both spikes
measure the same things with the same instruments.

## Running

```bash
cd spike/camoufox && npm install --no-audit --no-fund   # camoufox 0.5.9
cd ../.. && bun install                                   # cloakbrowser + playwright-core

TMPDIR=~/.cache/10x-chat-tmp node spike/readiness/run-all.mjs
```

Individual matrices:

```bash
node spike/readiness/proxy-matrix.mjs
node spike/readiness/lifecycle-matrix.mjs
node spike/readiness/ops-matrix.mjs
node spike/readiness/provider-matrix.mjs
```

Useful environment variables:

| Variable | Effect |
|---|---|
| `SPIKE_HEADLESS=1` | headless mode (no window, no desktop focus) |
| `SPIKE_PROXY=<url>` | proxy endpoint for both engines (default `http://127.0.0.1:3128`) |
| `SPIKE_ENGINES=camoufox,cloakbrowser` | run a subset of engines; the result is merged into the existing report |
| `SPIKE_PROVIDERS=grok,gemini` | run a subset of providers (smoke run of the harness itself) |
| `SPIKE_MAX_RUNS=1` | cap the runs per provider (smoke run); such a report is marked `reduced: true` and is never reused as a full result |
| `SPIKE_REUSE=1` | `run-all.mjs` reuses finished reports instead of re-running the matrices — but only when the saved report has the same versions, proxy and headless setting, otherwise the matrix is re-run and the reasons are printed |

Results are written to `spike/readiness/results/*.json`. The harness writes them with
`JSON.stringify`, so re-format them before committing — CI runs `biome check .`
over the whole repository:

```bash
./node_modules/.bin/biome format --write spike/readiness/results/
```

## Gate exit codes

`run-all.mjs` ends with an exit code a CI job can rely on:

| Exit code | Meaning |
|---|---|
| `0` | every matrix ran, every check passed, no criterion is unfinished |
| `1` | a check failed, a matrix crashed, or a report is partial/incomplete |
| `2` | no hard failure, but a criterion is unfinished (e.g. no credentials) |

The authorized round-trip is a matrix criterion: 5 providers × 2 engines = 10 mandatory
combinations, each with its own result; the criterion is `done` only when all 10 passed.

## Notes

- CloakBrowser runs on the **free** build (146.0.7680.177.5) by default: the
  Pro build installed in this environment (156.0.8078.47.1) refuses to start.
  Set `CLOAKBROWSER_USE_PRO=1` to try the Pro build instead.
- The provider matrix can run headless (`SPIKE_HEADLESS=1`). The canonical
  recorded run was **headed** under a virtual display, because a headed run
  steals desktop focus otherwise — run Xvfb and point `DISPLAY` at it:

  ```bash
  # Xvfb without root: unpack xorg-x11-server-Xvfb into a prefix and run it there
  PREFIX=/home/max/.cache/xvfb-root
  LD_LIBRARY_PATH="$PREFIX/usr/lib64" "$PREFIX/usr/bin/Xvfb" :99 -screen 0 1920x1080x24 -nolisten tcp &
  DISPLAY=:99 node spike/readiness/run-all.mjs
  ```

  Headless results are **not** directly comparable with a headed production run
  (Cloudflare behaviour differs between the two), and the report records the
  `harness.headless` setting so a run can never be silently reused for another.
- The authorized round-trip needs an existing storage state in
  `~/.10x-chat/profiles/default/storage-state.json` (Playwright format). Without
  credentials the round-trip is recorded as **unfinished**, never as a pass.
  The file stays outside the repository and only its path is recorded in the
  report — cookie values are never written to the results or to the logs.
  Each round-trip sends the probe twice: the second exchange
  runs in a new browser on the session state of the first one and must not land on a login page.
- Synthetic proxy credentials are used on purpose: they prove whether
  credentials reach the page, the process table or the report.
