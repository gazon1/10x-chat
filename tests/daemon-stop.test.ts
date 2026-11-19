import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestDaemonStop } from '../src/browser/daemon.js';

/**
 * The stop of the shared browser daemon.
 *
 * The stop of the daemon must not take the browser away from a session of
 * another process. The barrier of the switch is what makes it safe: the
 * daemon stops accepting new sessions, waits for the session creations that
 * are already running and reports what work it has left. A stop without that
 * barrier races with a session that starts in the meantime.
 */
const originalEnv = process.env;
let tempHome = '';
let daemonProcess: ChildProcess | undefined;
let daemonPid = 0;
const servers: Server[] = [];

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-daemon-stop-'));
  process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };

  // A process that is alive and may be stopped: the pid of the daemon must
  // be a real one, or the state file is treated as stale.
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

/** A daemon that answers the endpoints of the switch. */
async function startDaemon(switchBody: unknown, status = 200): Promise<number> {
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, activeContexts: 0, activePages: 0, pendingCreations: 0 }));
      return;
    }
    if (req.url === '/switch') {
      res.end(JSON.stringify(switchBody));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return address.port;
}

/** The endpoints the daemon was asked for. */
const asked: string[] = [];

async function writeState(port: number): Promise<void> {
  await writeFile(
    path.join(tempHome, 'browser-daemon.json'),
    JSON.stringify({
      pid: daemonPid,
      port,
      token: 'token',
      headless: true,
      version: '1.0.0',
      createdAt: new Date().toISOString(),
    }),
  );
}

describe('the stop of the daemon', () => {
  it('goes through the barrier of the switch', async () => {
    asked.length = 0;
    const port = await startDaemon({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    await writeState(port);

    expect(await requestDaemonStop()).toBe('stopped');
    // The barrier comes first: the daemon does not accept new sessions while
    // it is checked, and a session that starts in the meantime is visible.
    expect(asked).toContain('/switch');
  });

  it('leaves a daemon that has the session of another process running', async () => {
    asked.length = 0;
    const port = await startDaemon({
      ok: true,
      activeContexts: 0,
      activePages: 1,
      pendingCreations: 0,
      drained: true,
    });
    await writeState(port);

    expect(await requestDaemonStop()).toBe('busy');
    // The switch is released: the daemon serves sessions again.
    expect(asked).toContain('/switch/abort');
  });

  it('leaves a daemon that does not confirm that it is idle running', async () => {
    asked.length = 0;
    // A daemon of an older version does not know the endpoint of the switch.
    const port = await startDaemon({ ok: false, error: 'Not found' }, 404);
    await writeState(port);

    expect(await requestDaemonStop()).toBe('refused');
  });

  it('stops a daemon without the barrier when the caller asks for it', async () => {
    asked.length = 0;
    const port = await startDaemon({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    await writeState(port);

    expect(await requestDaemonStop({ force: true })).toBe('stopped');
  });

  it('reports a daemon that is not running', async () => {
    // A port that nothing listens on: the daemon is really gone.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeState(port);

    expect(await requestDaemonStop()).toBe('not-running');
  });
});
