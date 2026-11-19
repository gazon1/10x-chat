/**
 * The lifecycle of an RPC of the browser daemon.
 *
 * An operation that does not answer in time may still run inside the browser:
 * the session of the operation must be invalidated, and the handle of the
 * session must be refused from now on. The test drives the real service over
 * real HTTP — only the browser is a fake.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcService } from '../src/browser/rpc-service.js';
import { SwitchGate } from '../src/browser/switch-gate.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * The state of the fake browser.
 *
 * One method hangs at a time: the test names it, and the operation that
 * hangs never answers until the test lets it finish.
 */
interface FakeState {
  hang: string | undefined;
  pending: Deferred<unknown> | undefined;
  /** The result of the hung method, for its late completion. */
  late: unknown;
  /** The arguments every method received. */
  received: Record<string, unknown[][]>;
}

interface FakePage {
  page: unknown;
  close: ReturnType<typeof vi.fn>;
  fileChooser: { setFiles: ReturnType<typeof vi.fn> };
  download: { saveAs: ReturnType<typeof vi.fn> };
}

interface FakeWorld {
  browser: unknown;
  page: FakePage;
  context: { close: ReturnType<typeof vi.fn> };
  /** The page of a context that arrives late. */
  latePage: Deferred<unknown>;
  /** The method that hangs, if any. */
  hang: (key: string | undefined) => void;
  /** The late completion of the hung method. */
  settle: () => void;
  /** The arguments every method received. */
  received: Record<string, unknown[][]>;
}

/** A method that hangs when the test names it. */
function hangable(
  state: FakeState,
  name: string,
  impl: (...args: unknown[]) => unknown = () => null,
) {
  return vi.fn(async (...args: unknown[]) => {
    state.received[name] = args;
    const result = impl(...args);
    if (state.hang === name) {
      const pending = deferred<unknown>();
      state.pending = pending;
      state.late = result;
      return pending.promise;
    }
    return result;
  });
}

/**
 * A browser whose context creates one page.
 *
 * Every method of the fake can hang: the test names the method that must not
 * answer, and the operation finishes only when the test lets it.
 */
function createFakeWorld(options: { latePage?: boolean } = {}): FakeWorld {
  const state: FakeState = { hang: undefined, pending: undefined, late: null, received: {} };
  const latePage = deferred<unknown>();

  const fileChooser = { setFiles: hangable(state, 'event.setFiles') };
  const download = {
    saveAs: hangable(state, 'event.saveAs'),
    suggestedFilename: () => 'file.txt',
  };

  const locator = {
    waitFor: hangable(state, 'locator.waitFor'),
    isVisible: hangable(state, 'locator.isVisible', () => true),
    click: hangable(state, 'locator.click'),
    fill: hangable(state, 'locator.fill'),
    count: hangable(state, 'locator.count', () => 1),
    textContent: hangable(state, 'locator.textContent', () => 'text'),
    innerHTML: hangable(state, 'locator.innerHTML', () => '<b>text</b>'),
    setInputFiles: hangable(state, 'locator.setInputFiles'),
    evaluate: hangable(state, 'locator.evaluate', () => 1),
  };

  const page = {
    url: () => 'https://example.test/',
    on: () => page,
    close: hangable(state, 'page.close'),
    title: hangable(state, 'page.title', () => 'Example'),
    goto: hangable(state, 'page.goto'),
    waitForTimeout: hangable(state, 'page.waitForTimeout'),
    waitForLoadState: hangable(state, 'page.waitForLoadState', async () => {
      // The wait takes longer than the default bound of the service: only
      // the bound the caller asked for lets it finish.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return null;
    }),
    waitForURL: hangable(state, 'page.waitForURL'),
    waitForEvent: hangable(state, 'page.waitForEvent', (event: string) =>
      event === 'download' ? download : fileChooser,
    ),
    waitForFunction: hangable(state, 'page.waitForFunction', () => null),
    evaluate: hangable(state, 'page.evaluate', () => 1),
    keyboard: {
      press: hangable(state, 'keyboard.press'),
      type: hangable(state, 'keyboard.type'),
      insertText: hangable(state, 'keyboard.insertText'),
    },
    locator: () => locator,
  };

  const context = {
    newPage: () => (options.latePage ? latePage.promise : Promise.resolve(page)),
    addInitScript: hangable(state, 'context.addInitScript'),
    storageState: hangable(state, 'context.storageState', () => ({})),
    cookies: hangable(state, 'context.cookies', () => []),
    close: hangable(state, 'context.close'),
  };

  const browser = {
    newContext: hangable(state, 'browser.newContext', async () => context),
  };

  return {
    browser,
    page: { page, close: page.close, fileChooser, download },
    context,
    latePage,
    hang: (key) => {
      state.hang = key;
    },
    settle: () => {
      state.pending?.resolve(state.late);
    },
    received: state.received,
  };
}

/** The service behind a real HTTP server. */
async function startService(service: RpcService): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    void service.handleRpcRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function rpc(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A method of the RPC, and the session its timeout must invalidate. */
interface RpcCase {
  kind: 'browser' | 'context' | 'page' | 'locator' | 'keyboard' | 'event';
  method: string;
  /** The label of the operation in the error of the timeout. */
  label: string;
  /** The session that the timeout invalidates. */
  session: 'none' | 'context' | 'page';
  args?: unknown[];
  /** The event that the call needs before it can hang. */
  event?: 'filechooser' | 'download';
}

/**
 * Every dispatched method of every category.
 *
 * The contract is the same for all of them: the operation fails with the bound
 * of the operation, the session of the operation is invalidated, and the late
 * completion of the operation changes nothing.
 */
const CASES: RpcCase[] = [
  { kind: 'browser', method: 'newContext', label: 'browser.newContext', session: 'none' },
  { kind: 'context', method: 'storageState', label: 'context.storageState', session: 'context' },
  { kind: 'context', method: 'cookies', label: 'context.cookies', session: 'context' },
  { kind: 'context', method: 'close', label: 'context.close', session: 'context' },
  {
    kind: 'page',
    method: 'goto',
    label: 'page.goto',
    session: 'page',
    args: ['https://example.test/'],
  },
  { kind: 'page', method: 'waitForTimeout', label: 'page.waitForTimeout', session: 'page' },
  { kind: 'page', method: 'waitForLoadState', label: 'page.waitForLoadState', session: 'page' },
  {
    kind: 'page',
    method: 'waitForURL',
    label: 'page.waitForURL',
    session: 'page',
    args: ['https://example.test/'],
  },
  {
    kind: 'page',
    method: 'waitForEvent',
    label: 'page.waitForEvent',
    session: 'page',
    args: ['filechooser'],
  },
  {
    kind: 'page',
    method: 'evaluate',
    label: 'page.evaluate',
    session: 'page',
    args: [{ __type: 'function', source: '() => 1' }],
  },
  {
    kind: 'page',
    method: 'waitForFunction',
    label: 'page.waitForFunction',
    session: 'page',
    args: [{ __type: 'function', source: '() => true' }, null, {}],
  },
  { kind: 'page', method: 'title', label: 'page.title', session: 'page' },
  { kind: 'page', method: 'close', label: 'page.close', session: 'page' },
  { kind: 'locator', method: 'waitFor', label: 'locator.waitFor', session: 'page', args: [{}] },
  {
    kind: 'locator',
    method: 'isVisible',
    label: 'locator.isVisible',
    session: 'page',
    args: [{}],
  },
  { kind: 'locator', method: 'click', label: 'locator.click', session: 'page', args: [{}] },
  { kind: 'locator', method: 'fill', label: 'locator.fill', session: 'page', args: ['text'] },
  { kind: 'locator', method: 'count', label: 'locator.count', session: 'page' },
  {
    kind: 'locator',
    method: 'textContent',
    label: 'locator.textContent',
    session: 'page',
    args: [{}],
  },
  {
    kind: 'locator',
    method: 'innerHTML',
    label: 'locator.innerHTML',
    session: 'page',
    args: [{}],
  },
  {
    kind: 'locator',
    method: 'setInputFiles',
    label: 'locator.setInputFiles',
    session: 'page',
    args: ['/tmp/file.txt'],
  },
  {
    kind: 'locator',
    method: 'evaluate',
    label: 'locator.evaluate',
    session: 'page',
    args: [{ __type: 'function', source: '() => 1' }],
  },
  { kind: 'keyboard', method: 'press', label: 'keyboard.press', session: 'page', args: ['Enter'] },
  { kind: 'keyboard', method: 'type', label: 'keyboard.type', session: 'page', args: ['hello'] },
  {
    kind: 'keyboard',
    method: 'insertText',
    label: 'keyboard.insertText',
    session: 'page',
    args: ['hello'],
  },
  {
    kind: 'event',
    method: 'setFiles',
    label: 'event.setFiles',
    session: 'page',
    args: ['/tmp/file.txt'],
    event: 'filechooser',
  },
  {
    kind: 'event',
    method: 'saveAs',
    label: 'event.saveAs',
    session: 'page',
    args: ['/tmp/file.txt'],
    event: 'download',
  },
];

function targetOf(
  testCase: RpcCase,
  ids: { contextId: string; pageId: string; eventId: string },
): Record<string, unknown> | undefined {
  if (testCase.kind === 'browser') return undefined;
  if (testCase.kind === 'context') return { contextId: ids.contextId };
  if (testCase.kind === 'event') return { eventId: ids.eventId, pageId: ids.pageId };
  if (testCase.kind === 'locator') {
    return { pageId: ids.pageId, steps: [{ type: 'locator', selector: '#target' }] };
  }
  return { pageId: ids.pageId };
}

describe('the lifecycle of an RPC of the daemon', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it('invalidates the page of an operation that did not answer in time', async () => {
    const world = createFakeWorld();
    const service = new RpcService({
      browser: world.browser as never,
      operationTimeoutMs: 100,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    const context = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    const contextId = (context.body.result as { id: string }).id;

    const created = await rpc(server.url, {
      kind: 'context',
      method: 'newPage',
      target: { contextId },
    });
    const pageId = (created.body.result as { id: string }).id;

    // The operation hangs: the call must fail with the bound of the operation.
    world.hang('page.evaluate');
    const hung = await rpc(server.url, {
      kind: 'page',
      method: 'evaluate',
      target: { pageId },
      args: [{ __type: 'function', source: '() => 1' }],
    });
    expect(hung.status).toBe(500);
    expect(hung.body.error).toMatch(/page\.evaluate did not answer within 100ms/);

    // The page of the operation was closed: the operation may still run.
    expect(world.page.close).toHaveBeenCalled();

    // The handle of the page is refused from now on.
    const refused = await rpc(server.url, {
      kind: 'page',
      method: 'evaluate',
      target: { pageId },
      args: [{ __type: 'function', source: '() => 1' }],
    });
    expect(refused.status).toBe(500);
    expect(refused.body.error).toMatch(/was invalidated after a timed-out operation/);

    // The late result of the operation changes nothing.
    world.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stillRefused = await rpc(server.url, {
      kind: 'page',
      method: 'title',
      target: { pageId },
    });
    expect(stillRefused.body.error).toMatch(/was invalidated after a timed-out operation/);
  });

  it('closes a page that arrives after the bound and refuses its context', async () => {
    const world = createFakeWorld({ latePage: true });
    const service = new RpcService({
      browser: world.browser as never,
      operationTimeoutMs: 100,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    const context = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    const contextId = (context.body.result as { id: string }).id;

    const hung = await rpc(server.url, {
      kind: 'context',
      method: 'newPage',
      target: { contextId },
    });
    expect(hung.status).toBe(500);
    expect(hung.body.error).toMatch(/context\.newPage did not answer within 100ms/);

    // The page arrives late: the client never learns its id, so it is closed.
    world.latePage.resolve(world.page.page);
    await vi.waitFor(() => expect(world.page.close).toHaveBeenCalled());

    // The context of the operation is refused from now on.
    const refused = await rpc(server.url, {
      kind: 'context',
      method: 'newPage',
      target: { contextId },
    });
    expect(refused.status).toBe(500);
    expect(refused.body.error).toMatch(/was invalidated after a timed-out operation/);
  });
});

describe('the options of the caller', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it('reach Playwright with the method that carries them', async () => {
    const world = createFakeWorld();
    const service = new RpcService({
      browser: world.browser as never,
      operationTimeoutMs: 100,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    const context = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    const contextId = (context.body.result as { id: string }).id;
    const created = await rpc(server.url, {
      kind: 'context',
      method: 'newPage',
      target: { contextId },
    });
    const pageId = (created.body.result as { id: string }).id;

    const waited = await rpc(server.url, {
      kind: 'page',
      method: 'waitForLoadState',
      target: { pageId },
      args: ['load', { timeout: 1_000 }],
    });
    expect(waited.status).toBe(200);
    // The options are not dropped by the dispatcher.
    expect(world.received['page.waitForLoadState']?.[1]).toEqual({ timeout: 1_000 });

    const filled = await rpc(server.url, {
      kind: 'locator',
      method: 'fill',
      target: { pageId, steps: [{ type: 'locator', selector: '#target' }] },
      args: ['text', { timeout: 5_000 }],
    });
    expect(filled.status).toBe(200);
    expect(world.received['locator.fill']?.[1]).toEqual({ timeout: 5_000 });
  });

  it('give the operation the bound the caller asked for', async () => {
    const world = createFakeWorld();
    const service = new RpcService({
      browser: world.browser as never,
      operationTimeoutMs: 100,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    const context = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    const contextId = (context.body.result as { id: string }).id;
    const created = await rpc(server.url, {
      kind: 'context',
      method: 'newPage',
      target: { contextId },
    });
    const pageId = (created.body.result as { id: string }).id;

    // The wait of the fake takes longer than the default bound of the
    // service: it only finishes because the caller asked for a longer bound.
    const waited = await rpc(server.url, {
      kind: 'page',
      method: 'waitForLoadState',
      target: { pageId },
      args: ['load', { timeout: 1_000 }],
    });
    expect(waited.status).toBe(200);

    // Without a bound of its own the same call runs into the default bound.
    const without = await rpc(server.url, {
      kind: 'page',
      method: 'waitForLoadState',
      target: { pageId },
      args: ['load'],
    });
    expect(without.status).toBe(500);
    expect(without.body.error).toMatch(/page\.waitForLoadState did not answer within 100ms/);
  });
});

describe('the timeout contract of every dispatched method', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  for (const testCase of CASES) {
    it(`fails ${testCase.label} with the bound of the operation`, async () => {
      const world = createFakeWorld();
      const service = new RpcService({
        browser: world.browser as never,
        operationTimeoutMs: 100,
        rpcTimeoutMs: 10_000,
        closeTimeoutMs: 100,
      });
      const server = await startService(service);
      servers.push(server);

      let contextId = '';
      let pageId = '';
      if (testCase.kind !== 'browser') {
        const context = await rpc(server.url, { kind: 'browser', method: 'newContext' });
        contextId = (context.body.result as { id: string }).id;
        const created = await rpc(server.url, {
          kind: 'context',
          method: 'newPage',
          target: { contextId },
        });
        pageId = (created.body.result as { id: string }).id;
      }

      // The event of the call must be registered before it can hang.
      let eventId = '';
      if (testCase.event) {
        const registered = await rpc(server.url, {
          kind: 'page',
          method: 'waitForEvent',
          target: { pageId },
          args: [testCase.event],
        });
        const handle = registered.body.result as { id: string; pageId: string };
        eventId = handle.id;
        // The page is part of the handle: the client sends it back with the
        // event, so a timed-out event invalidates the page of the event.
        expect(handle.pageId).toBe(pageId);
      }

      world.hang(`${testCase.kind}.${testCase.method}`);

      const hung = await rpc(server.url, {
        kind: testCase.kind,
        method: testCase.method,
        target: targetOf(testCase, { contextId, pageId, eventId }),
        args: testCase.args,
      });

      // The operation fails with the bound of the operation, not with the
      // bound of the RPC.
      expect(hung.status).toBe(500);
      expect(hung.body.error).toMatch(new RegExp(`${testCase.label} did not answer within \\d+ms`));
      expect(hung.body.error).not.toMatch(/^rpc /);

      world.hang(undefined);

      if (testCase.session === 'page') {
        const refused = await rpc(server.url, {
          kind: 'page',
          method: 'title',
          target: { pageId },
        });
        expect(refused.body.error).toMatch(/was invalidated after a timed-out operation/);
      } else if (testCase.session === 'context') {
        const refused = await rpc(server.url, {
          kind: 'context',
          method: 'cookies',
          target: { contextId },
        });
        expect(refused.body.error).toMatch(/was invalidated after a timed-out operation/);
      } else {
        // A call without a session invalidates nothing: the daemon still serves.
        const next = await rpc(server.url, { kind: 'browser', method: 'newContext' });
        expect(next.status).toBe(200);
      }

      // The late completion of the operation changes nothing.
      world.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      if (testCase.session === 'page') {
        const stillRefused = await rpc(server.url, {
          kind: 'page',
          method: 'title',
          target: { pageId },
        });
        expect(stillRefused.body.error).toMatch(/was invalidated after a timed-out operation/);
      } else if (testCase.session === 'context') {
        const stillRefused = await rpc(server.url, {
          kind: 'context',
          method: 'cookies',
          target: { contextId },
        });
        expect(stillRefused.body.error).toMatch(/was invalidated after a timed-out operation/);
      } else {
        // The context that arrived late is closed instead of being registered.
        await vi.waitFor(() => expect(world.context.close).toHaveBeenCalled());
      }
    });
  }
});

describe('the switch gate of the daemon', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it('keeps a creation that outlasted its bound registered', async () => {
    const world = createFakeWorld();
    const switchGate = new SwitchGate();
    const service = new RpcService({
      browser: world.browser as never,
      switchGate,
      operationTimeoutMs: 100,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    // The creation hangs: it outlasts the bound of the operation.
    world.hang('browser.newContext');
    const hung = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    expect(hung.status).toBe(500);
    expect(hung.body.error).toMatch(/browser\.newContext did not answer within 100ms/);

    // The creation is still running inside the browser: the daemon must not
    // look idle, and a switch must be refused.
    expect(switchGate.pendingCreations).toBe(1);
    expect(await switchGate.waitForIdle(50)).toBe(false);

    // The creation settles: now the gate is idle.
    world.settle();
    await vi.waitFor(() => expect(switchGate.pendingCreations).toBe(0));
    expect(await switchGate.waitForIdle(50)).toBe(true);
  });

  it('releases the gate once a finished creation is registered', async () => {
    const world = createFakeWorld();
    const switchGate = new SwitchGate();
    const service = new RpcService({
      browser: world.browser as never,
      switchGate,
      operationTimeoutMs: 1_000,
      rpcTimeoutMs: 10_000,
      closeTimeoutMs: 100,
    });
    const server = await startService(service);
    servers.push(server);

    const created = await rpc(server.url, { kind: 'browser', method: 'newContext' });
    expect(created.status).toBe(200);

    // The context is registered and the gate is idle again.
    expect(service.health().activeContexts).toBe(1);
    await vi.waitFor(() => expect(switchGate.pendingCreations).toBe(0));
    expect(await switchGate.waitForIdle(50)).toBe(true);
  });
});
