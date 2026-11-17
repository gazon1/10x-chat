import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortDaemonSwitch,
  beginDaemonSwitch,
  type DaemonHealth,
  type DaemonState,
  daemonBusyError,
  daemonIsBusy,
  daemonMayBeStopped,
  daemonSwitchTimeoutError,
  fetchDaemonHealth,
  isDaemonCompatible,
} from '../src/browser/daemon.js';

const PROXY = 'proxy-fingerprint';

function state(headless: boolean): DaemonState {
  return {
    pid: 1234,
    port: 5678,
    token: 'token',
    headless,
    proxy: PROXY,
    createdAt: new Date().toISOString(),
  };
}

describe('isDaemonCompatible', () => {
  it('reuses a daemon with the same headless mode', () => {
    expect(isDaemonCompatible(state(true), true, PROXY)).toBe(true);
    expect(isDaemonCompatible(state(false), false, PROXY)).toBe(true);
  });

  it('restarts a headed daemon for a headless request', () => {
    expect(isDaemonCompatible(state(false), true, PROXY)).toBe(false);
  });

  it('restarts a headless daemon for a headed request', () => {
    expect(isDaemonCompatible(state(true), false, PROXY)).toBe(false);
  });

  it('restarts a daemon with another proxy', () => {
    expect(isDaemonCompatible(state(true), true, 'another-proxy')).toBe(false);
  });
});

describe('the health of the daemon', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function startHealthServer(body: unknown): Promise<number> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    return address.port;
  }

  it('reads the active sessions of the daemon', async () => {
    const port = await startHealthServer({ ok: true, activeContexts: 1, activePages: 2 });
    const health = await fetchDaemonHealth({ ...state(true), port });

    expect(health).toEqual({ activeContexts: 1, activePages: 2, pendingCreations: 0 });
  });

  it('reads the session creations that are still running', async () => {
    const port = await startHealthServer({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 1,
    });
    const health = await fetchDaemonHealth({ ...state(true), port });

    expect(health?.pendingCreations).toBe(1);
  });

  it('reports no daemon when it does not answer', async () => {
    // Nothing listens on this port.
    expect(await fetchDaemonHealth({ ...state(true), port: 1 })).toBeUndefined();
  });
});

describe('a busy daemon', () => {
  const idle: DaemonHealth = { activeContexts: 0, activePages: 0, pendingCreations: 0 };
  const busy: DaemonHealth = { activeContexts: 1, activePages: 1, pendingCreations: 0 };

  it('is busy when it still has a session of another process', () => {
    expect(daemonIsBusy(busy)).toBe(true);
  });

  it('is busy when a session is still being created', () => {
    // The context does not exist yet, but the session does: it must not lose
    // its browser.
    expect(daemonIsBusy({ activeContexts: 0, activePages: 0, pendingCreations: 1 })).toBe(true);
  });

  it('is not busy when it has no session', () => {
    expect(daemonIsBusy(idle)).toBe(false);
    expect(daemonIsBusy(undefined)).toBe(false);
  });

  it('explains that the other session would be ended', () => {
    const error = daemonBusyError('a different headless mode (headed → headless)', busy);
    expect(error.message).toMatch(/busy with another session/);
    expect(error.message).toMatch(/headed → headless/);
    expect(error.message).toMatch(/would end that session/);
  });

  it('names the pending creation instead of the pages', () => {
    const error = daemonBusyError('a different proxy', {
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 1,
    });
    expect(error.message).toMatch(/1 pending creation\(s\)/);
    expect(error.message).not.toMatch(/0 active page\(s\)/);
  });

  it('explains a session creation that did not finish in time', () => {
    const error = daemonSwitchTimeoutError('a different headless mode (headed → headless)', {
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 1,
    });
    expect(error.message).toMatch(/still being created/);
    expect(error.message).toMatch(/would end that session/);
  });
});

describe('the barrier of a switching daemon', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const paths: string[] = [];

  afterEach(async () => {
    paths.length = 0;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function startSwitchServer(body: unknown): Promise<number> {
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    return address.port;
  }

  it('asks the daemon to refuse new sessions and reads what is left', async () => {
    const port = await startSwitchServer({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    const drained = await beginDaemonSwitch({ ...state(true), port });

    expect(drained).toEqual({
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    expect(paths).toEqual(['/switch']);
  });

  it('sees the session that started in the meantime', async () => {
    const port = await startSwitchServer({
      ok: true,
      activeContexts: 1,
      activePages: 1,
      pendingCreations: 0,
      drained: true,
    });
    const drained = await beginDaemonSwitch({ ...state(true), port });

    expect(daemonIsBusy(drained)).toBe(true);
  });

  it('sees the creation that did not finish in time', async () => {
    // The daemon waited for the running creation and ran into its timeout:
    // the switch must be refused, the daemon must not be stopped.
    const port = await startSwitchServer({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 1,
      drained: false,
    });
    const drained = await beginDaemonSwitch({ ...state(true), port });

    expect(drained?.drained).toBe(false);
    expect(daemonIsBusy(drained)).toBe(true);
    expect(drained && daemonMayBeStopped(drained)).toBe(false);
  });

  it('may stop a daemon that is idle and drained', async () => {
    const port = await startSwitchServer({
      ok: true,
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    const drained = await beginDaemonSwitch({ ...state(true), port });

    expect(drained && daemonMayBeStopped(drained)).toBe(true);
  });

  it('releases the daemon when the switch is refused', async () => {
    const port = await startSwitchServer({ ok: true });
    await abortDaemonSwitch({ ...state(true), port });

    expect(paths).toEqual(['/switch/abort']);
  });

  it('reports no daemon when it does not answer', async () => {
    expect(await beginDaemonSwitch({ ...state(true), port: 1 })).toBeUndefined();
  });
});
