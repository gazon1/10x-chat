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

interface FakePage {
  page: unknown;
  close: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
}

function createFakePage(evaluate: () => Promise<unknown>): FakePage {
  const close = vi.fn(async () => {});
  const evaluateFn = vi.fn(evaluate);
  const page = {
    url: () => 'https://example.test/',
    on: () => page,
    close,
    evaluate: evaluateFn,
    title: async () => 'Example',
  };
  return { page, close, evaluate: evaluateFn };
}

interface FakeBrowser {
  browser: unknown;
  newPage: Deferred<unknown>;
  page: FakePage;
}

/**
 * A browser whose context creates one page.
 *
 * The page of the context arrives only when the test resolves `newPage`: a
 * page that arrives late must be closed instead of being used.
 */
function createFakeBrowser(options: { page?: FakePage; latePage?: boolean } = {}): FakeBrowser {
  const newPage = deferred<unknown>();
  const page = options.page ?? createFakePage(() => new Promise(() => {}));

  const context = {
    newPage: () => (options.latePage ? newPage.promise : Promise.resolve(page.page)),
    addInitScript: async () => {},
    storageState: async () => ({}),
    cookies: async () => [],
    close: async () => {},
  };

  const browser = {
    newContext: async () => context,
  };

  return { browser, newPage, page };
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

describe('the lifecycle of an RPC of the daemon', () => {
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it('invalidates the page of an operation that did not answer in time', async () => {
    const evaluate = deferred<unknown>();
    const fake = createFakeBrowser({ page: createFakePage(() => evaluate.promise) });
    const service = new RpcService({
      browser: fake.browser as never,
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
    const hung = await rpc(server.url, {
      kind: 'page',
      method: 'evaluate',
      target: { pageId },
      args: [{ __type: 'function', source: '() => 1' }],
    });
    expect(hung.status).toBe(500);
    expect(hung.body.error).toMatch(/page\.evaluate did not answer within 100ms/);

    // The page of the operation was closed: the operation may still run.
    expect(fake.page.close).toHaveBeenCalled();

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
    evaluate.resolve(42);
    const stillRefused = await rpc(server.url, {
      kind: 'page',
      method: 'title',
      target: { pageId },
    });
    expect(stillRefused.body.error).toMatch(/was invalidated after a timed-out operation/);
  });

  it('closes a page that arrives after the bound and refuses its context', async () => {
    const latePage = createFakePage(() => Promise.resolve(null));
    const fake = createFakeBrowser({ page: latePage, latePage: true });
    const service = new RpcService({
      browser: fake.browser as never,
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
    fake.newPage.resolve(latePage.page);
    await vi.waitFor(() => expect(latePage.close).toHaveBeenCalled());

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
