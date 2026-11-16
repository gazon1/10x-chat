# Camoufox spike (isolated)

Isolated evaluation of [Camoufox](https://github.com/daijro/camoufox) as a replacement browser
runtime for 10x-chat. Nothing here touches the production runtime (`src/browser/*`): this
directory has its own `package.json` and its own `node_modules`.

Findings and the GO/NO-GO decision: [`docs/refactor-3-8-camoufox.md`](../../docs/refactor-3-8-camoufox.md).

## Run

```bash
cd spike/camoufox
npm install                 # camoufox@0.5.9 + playwright-core@1.62.0
npx camoufox fetch          # browser build (paired with camoufox 0.5.9)

# The project's providers need the local proxy:
export HTTPS_PROXY=http://127.0.0.1:3128
export HTTP_PROXY=http://127.0.0.1:3128
export NO_PROXY=localhost,127.0.0.1,::1

node spike.mjs              # writes report.json next to this file
```

Useful switches:

| Variable | Meaning |
|---|---|
| `SPIKE_PROXY` | proxy used for the proxied provider smoke (default `http://127.0.0.1:3128`) |
| `SPIKE_GEOIP=1` | pass `geoip: true` to the launcher, so timezone/locale/geolocation/WebRTC IP follow the proxy exit IP |

## Files

| File | What it is |
|---|---|
| `spike.mjs` | the checks: launch, navigation, upload/download, persistent profile, storage state, proxies, remote server, cleanup, headed mode, provider smoke |
| `fixtures.mjs` | local HTTP server (upload / download / cookie / storage endpoints) |
| `proxies.mjs` | local HTTP CONNECT proxy and SOCKS5 proxy (RFC 1929 user/pass), both logging tunnelled targets |
| `report.json` | machine-readable result of the last run |

The proxies are local and disposable on purpose: they prove the browser really tunnelled through
the configured proxy (including the SOCKS5 auth handshake) instead of trusting the exit IP alone.

## Cleanup

```bash
rm -rf spike/camoufox/.data
```
