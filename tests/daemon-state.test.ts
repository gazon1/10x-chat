import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDaemonState } from '../src/browser/daemon.js';
import { fingerprintProxy } from '../src/browser/proxy.js';
import { resolveEffectiveProxy } from '../src/config.js';
import { getPackageVersion } from '../src/version.js';

/**
 * The daemon that serves the request.
 *
 * A running daemon that fits the request is reused — the run must not start a
 * second browser. A daemon that does not fit it may only be replaced when it
 * has no session of another process any more.
 */
const originalEnv = process.env;
let tempHome = '';
let daemonProcess: ChildProcess | undefined;
let daemonPid = 0;
const servers: Server[] = [];

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-daemon-state-'));
  process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };

  // A process that is alive: a pid that is not alive makes the state file
  // look stale.
  daemonProcess = spawn('sleep', ['300'], { stdio: 'ignore' });
  daemonPid = daemonProcess.pid ?? 0;
});

afterEach(async () => {
  process.env = originalEnv;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  if (daemonProcess && daemonProcess.exitCode === null) daemonProcess.kill('SIGKILL');
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
});

/** A daemon that answers with the given load. */
async function startDaemon(health: unknown): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return address.port;
}

async function writeState(port: number, version: string): Promise<void> {
  await writeFile(
    path.join(tempHome, 'browser-daemon.json'),
    JSON.stringify({
      pid: daemonPid,
      port,
      token: 'token',
      headless: true,
      proxy: fingerprintProxy(await resolveEffectiveProxy()),
      version,
      createdAt: new Date().toISOString(),
    }),
  );
}

describe('the daemon that serves the request', () => {
  it('reuses a running daemon that fits the request', async () => {
    const port = await startDaemon({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
    });
    await writeState(port, getPackageVersion());

    const state = await ensureDaemonState(true);
    expect(state.port).toBe(port);
    expect(state.pid).toBe(daemonPid);
  });

  it('does not replace a daemon that has the session of another process', async () => {
    const port = await startDaemon({
      ok: true,
      activeContexts: 0,
      activePages: 1,
      pendingCreations: 0,
    });
    // A daemon of another version does not fit the request and must be
    // replaced — but it has the session of another process.
    await writeState(port, '0.0.1');

    await expect(ensureDaemonState(true)).rejects.toThrow(/busy with another session/);
  });
});
