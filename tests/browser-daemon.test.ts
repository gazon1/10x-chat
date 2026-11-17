import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortDaemonSwitch,
  beginDaemonSwitch,
  type DaemonHealth,
  type DaemonState,
  daemonBusyError,
  daemonIsBusy,
  daemonMayBeStopped,
  daemonSwitchFailedError,
  daemonSwitchTimeoutError,
  decideDaemonSwitch,
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

/** A port that nothing listens on: the daemon is really gone. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

  async function startSwitchServer(answer: (res: ServerResponse) => void): Promise<number> {
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      answer(res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    return address.port;
  }

  function jsonServer(body: unknown) {
    return (res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }

  it('asks the daemon to refuse new sessions and reads what is left', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('switched');
    expect(result.outcome === 'switched' && result.health).toEqual({
      activeContexts: 0,
      activePages: 0,
      pendingCreations: 0,
      drained: true,
    });
    expect(paths).toEqual(['/switch']);
  });

  it('sees the session that started in the meantime', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 1,
        activePages: 1,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(daemonIsBusy(result.outcome === 'switched' ? result.health : undefined)).toBe(true);
  });

  it('sees the creation that did not finish in time', async () => {
    // The daemon waited for the running creation and ran into its timeout:
    // the switch must be refused, the daemon must not be stopped.
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 1,
        drained: false,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome === 'switched' && result.health.drained).toBe(false);
    expect(result.outcome === 'switched' && daemonIsBusy(result.health)).toBe(true);
    expect(result.outcome === 'switched' && daemonMayBeStopped(result.health)).toBe(false);
  });

  it('may stop a daemon that is idle and drained', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome === 'switched' && daemonMayBeStopped(result.health)).toBe(true);
  });

  it('releases the daemon when the switch is refused', async () => {
    const port = await startSwitchServer(jsonServer({ ok: true }));
    await abortDaemonSwitch({ ...state(true), port });

    expect(paths).toEqual(['/switch/abort']);
  });

  it('reports an unavailable daemon when nothing listens on the port', async () => {
    const port = await closedPort();
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('unavailable');
  });

  it('reports a failed switch when the daemon does not know the endpoint', async () => {
    // A daemon of an older version answers 404 — it is alive, but it cannot
    // be switched. That is not a proof that it has no session.
    const port = await startSwitchServer((res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    });
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.httpStatus).toBe(404);
  });

  it('reports a failed switch when the daemon refuses the request', async () => {
    const port = await startSwitchServer((res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    });
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.httpStatus).toBe(401);
  });

  it('reports a failed switch when the answer cannot be read', async () => {
    const port = await startSwitchServer((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json');
    });
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });

  it('reports a failed switch when the answer is empty', async () => {
    // An empty answer is not an idle daemon: it is an answer that says
    // nothing about the sessions of the daemon.
    const port = await startSwitchServer(jsonServer({}));
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toMatch(/did not confirm/);
  });

  it('reports a failed switch when the answer does not confirm the request', async () => {
    const port = await startSwitchServer(
      jsonServer({
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });

  it('reports a failed switch when the state is missing', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 0,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toMatch(/incomplete result/);
  });

  it('reports a failed switch when a counter is missing', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });

  it('reports a failed switch when a counter is not a number', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: '0',
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });

  it('reports a failed switch when a counter is negative', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: -1,
        activePages: 0,
        pendingCreations: 0,
        drained: true,
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });

  it('reports a failed switch when the state is not a boolean', async () => {
    const port = await startSwitchServer(
      jsonServer({
        ok: true,
        activeContexts: 0,
        activePages: 0,
        pendingCreations: 0,
        drained: 'yes',
      }),
    );
    const result = await beginDaemonSwitch({ ...state(true), port });

    expect(result.outcome).toBe('failed');
  });
});

describe('what the switch result means', () => {
  const reason = 'a different headless mode (headed → headless)';

  it('replaces a daemon that is really gone', () => {
    const decision = decideDaemonSwitch({ outcome: 'unavailable', reason: 'gone' }, reason);

    expect(decision.action).toBe('restart');
  });

  it('refuses the switch when the daemon does not answer with a result', () => {
    const decision = decideDaemonSwitch(
      { outcome: 'failed', reason: 'HTTP 404', httpStatus: 404 },
      reason,
    );

    // A second daemon would break the session the old daemon may still serve.
    expect(decision.action).toBe('refuse');
    expect(decision.action === 'refuse' && decision.error.message).toMatch(/HTTP 404/);
  });

  it('explains that a daemon of an older version cannot be switched', () => {
    const decision = decideDaemonSwitch(
      { outcome: 'failed', reason: 'HTTP 404', httpStatus: 404 },
      reason,
    );

    expect(decision.action === 'refuse' && decision.error.message).toMatch(
      /older version of 10x-chat/,
    );
  });

  it('refuses the switch when a session of another process is still running', () => {
    const decision = decideDaemonSwitch(
      {
        outcome: 'switched',
        health: { activeContexts: 1, activePages: 1, pendingCreations: 0, drained: true },
      },
      reason,
    );

    expect(decision.action).toBe('refuse');
    expect(decision.action === 'refuse' && decision.error.message).toMatch(
      /busy with another session/,
    );
  });

  it('refuses the switch when a creation did not finish in time', () => {
    const decision = decideDaemonSwitch(
      {
        outcome: 'switched',
        health: { activeContexts: 0, activePages: 0, pendingCreations: 1, drained: false },
      },
      reason,
    );

    expect(decision.action).toBe('refuse');
    expect(decision.action === 'refuse' && decision.error.message).toMatch(/still being created/);
  });

  it('stops a daemon that is idle and drained', () => {
    const decision = decideDaemonSwitch(
      {
        outcome: 'switched',
        health: { activeContexts: 0, activePages: 0, pendingCreations: 0, drained: true },
      },
      reason,
    );

    expect(decision.action).toBe('stop');
  });

  it('says that the daemon was left running', () => {
    const error = daemonSwitchFailedError(reason, {
      outcome: 'failed',
      reason: 'the daemon answered the switch request with HTTP 404',
      httpStatus: 404,
    });

    expect(error.message).toMatch(/left running/);
    expect(error.message).toMatch(/session of another process/);
    expect(error.message).toMatch(/headed → headless/);
  });
});
