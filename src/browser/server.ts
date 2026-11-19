// HTTP daemon architecture inspired by gstack (github.com/garrytan/gstack)

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import type { Browser } from 'playwright';
import { resolveEffectiveProxy } from '../config.js';
import { getAppDir } from '../paths.js';
import { getChromium, getEngineName } from './engine.js';
import { CHROMIUM_ARGS } from './process.js';
import { fingerprintProxy } from './proxy.js';
import { RpcService, redactError } from './rpc-service.js';
import { detectChromeChannel } from './stealth.js';
import { SwitchGate } from './switch-gate.js';

interface DaemonStateFile {
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  /** Fingerprint of the proxy the browser was started with (no secrets). */
  proxy?: string;
  createdAt: string;
}

const STATE_PATH =
  process.env.TEN_X_CHAT_BROWSER_STATE_FILE ?? path.join(getAppDir(), 'browser-daemon.json');
const AUTH_TOKEN = randomUUID();
const HEADLESS = process.env.TEN_X_CHAT_BROWSER_HEADLESS !== '0';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWITCH_TIMEOUT_MS = 10_000;
const MIN_PORT = 10_000;
const MAX_PORT = 60_000;

let browser: Browser | null = null;
let lastActivity = Date.now();
let shuttingDown = false;

/**
 * The barrier of a switching daemon: while it is closed, no new session may
 * start, so the daemon can be replaced without taking the browser away from a
 * session that is just beginning.
 */
const switchGate = new SwitchGate();

function touchActivity(): void {
  lastActivity = Date.now();
}

async function writeStateFile(port: number, proxy: string): Promise<void> {
  const state: DaemonStateFile = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    headless: HEADLESS,
    proxy,
    createdAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmpPath, STATE_PATH);
  await chmod(STATE_PATH, 0o600).catch(() => {
    // ignore chmod failures
  });
}

async function clearStateFile(): Promise<void> {
  await rm(STATE_PATH, { force: true }).catch(() => {
    // ignore
  });
}

async function findPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    const available = await new Promise<boolean>((resolve) => {
      const tester = createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`Unable to find an available port in range ${MIN_PORT}-${MAX_PORT}`);
}

async function shutdown(server?: ReturnType<typeof createServer>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await clearStateFile();

  // Close browser first — this aborts any pending Playwright actions, which
  // unblocks any active long-poll HTTP connections to the server.
  // Add a hard 3s timeout: browser.close() can hang if Playwright's IPC
  // channel is already broken (e.g. Chrome crashed or was kill -9'd).
  if (browser) {
    browser.removeAllListeners('disconnected');
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  // Stop accepting new connections. Active connections will have been aborted
  // by browser.close() above, so this resolves quickly. We add a 2s hard
  // timeout so a stuck connection never prevents the process from exiting.
  if (server) {
    await Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {
      // ignore
    });
  }

  process.exit(0);
}

async function main(): Promise<void> {
  const channel = detectChromeChannel();

  // The proxy of the daemon: the config file first, the environment second.
  // The browser gets exactly this proxy, and its fingerprint goes into the
  // state file — a client with another proxy switches the daemon.
  const proxy = await resolveEffectiveProxy();

  const chromium = await getChromium();
  const engineName = getEngineName();
  console.log(`Browser engine: ${engineName}${channel ? ' (channel: chrome)' : ''}`);

  browser = await chromium.launch({
    headless: HEADLESS,
    ...(channel ? { channel } : {}),
    args: CHROMIUM_ARGS,
  });

  // Inject stealth script into the default browser context
  // so every new page automatically gets the anti-detection patches
  browser.on('disconnected', () => {
    void clearStateFile().finally(() => process.exit(1));
  });

  const service = new RpcService({ browser, switchGate });

  const idleInterval = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      void shutdown(server);
    }
  }, 60_000);
  idleInterval.unref();

  const port = await findPort();
  const server = createServer(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const health = service.health();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          activeContexts: health.activeContexts,
          activePages: health.activePages,
          // A context that is being created is a session of another process
          // too: it is not in `contexts` yet, but it must not be cut off.
          pendingCreations: health.pendingCreations,
          switching: health.switching,
          headless: HEADLESS,
          pid: process.pid,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/switch') {
      // Close the gate, wait for the session creations that are running and
      // report what is left: a session that started in the meantime is
      // visible now.
      switchGate.close();
      const drained = await switchGate.waitForIdle(SWITCH_TIMEOUT_MS);
      const health = service.health();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          activeContexts: health.activeContexts,
          activePages: health.activePages,
          pendingCreations: health.pendingCreations,
          // A wait that ran into its timeout does not mean "no work": a
          // creation is still running and belongs to a session of another
          // process.
          drained,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/switch/abort') {
      // The switch was refused — the daemon serves sessions again.
      switchGate.open();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        void shutdown(server);
      }, 0);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    touchActivity();

    await service.handleRpcRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  await writeStateFile(port, fingerprintProxy(proxy));

  const cleanup = () => {
    void shutdown(server);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

void main().catch(async (error) => {
  console.error(redactError(error));
  await clearStateFile();
  process.exit(1);
});
