import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIMEOUT_MS,
  InvalidatedHandles,
  invalidatedHandle,
  invalidateOnTimeout,
  OperationTimeoutError,
  RPC_TIMEOUT_MS,
  withLateResultCleanup,
  withOperationTimeout,
} from '../src/browser/operation-timeout.js';

describe('the bound of the client', () => {
  it('is longer than the bound of the server', () => {
    // The server answers a hung call with an error and invalidates the
    // session: the client has to wait long enough to read that answer.
    expect(CLIENT_TIMEOUT_MS).toBeGreaterThan(RPC_TIMEOUT_MS);
  });
});

describe('withOperationTimeout', () => {
  it('answers with the result of the operation', async () => {
    await expect(withOperationTimeout(Promise.resolve('ok'), 'page.evaluate', 1_000)).resolves.toBe(
      'ok',
    );
  });

  it('fails with a timeout error when the operation does not answer', async () => {
    const never = new Promise<void>(() => {});
    await expect(withOperationTimeout(never, 'page.evaluate', 20)).rejects.toThrow(
      OperationTimeoutError,
    );
  });

  it('names the operation in the error', async () => {
    const never = new Promise<void>(() => {});
    await expect(withOperationTimeout(never, 'page.evaluate', 20)).rejects.toThrow(
      /page\.evaluate did not answer within 20ms/,
    );
  });
});

describe('invalidatedHandle', () => {
  it('invalidates the page of the operation', () => {
    expect(invalidatedHandle({ pageId: 'p1' })).toEqual({ kind: 'page', id: 'p1' });
  });

  it('invalidates the context when the operation works on the context', () => {
    expect(invalidatedHandle({ contextId: 'c1' })).toEqual({ kind: 'context', id: 'c1' });
  });

  it('has nothing to invalidate without a handle', () => {
    expect(invalidatedHandle(undefined)).toBeNull();
    expect(invalidatedHandle({})).toBeNull();
  });
});

describe('invalidateOnTimeout', () => {
  it('invalidates the session of an operation that timed out', async () => {
    const invalidate = vi.fn(async () => {});

    const handle = await invalidateOnTimeout(
      new OperationTimeoutError('page.evaluate', 60_000),
      { pageId: 'p1' },
      invalidate,
    );

    expect(handle).toEqual({ kind: 'page', id: 'p1' });
    expect(invalidate).toHaveBeenCalledWith({ kind: 'page', id: 'p1' });
  });

  it('keeps the session of an operation that failed for another reason', async () => {
    const invalidate = vi.fn(async () => {});

    const handle = await invalidateOnTimeout(
      new Error('the page is gone'),
      { pageId: 'p1' },
      invalidate,
    );

    expect(handle).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('has no session to invalidate without a handle', async () => {
    const invalidate = vi.fn(async () => {});

    const handle = await invalidateOnTimeout(
      new OperationTimeoutError('browser.newContext', 60_000),
      undefined,
      invalidate,
    );

    expect(handle).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('withLateResultCleanup', () => {
  it('answers with the created object when it arrives in time', async () => {
    const created = { id: 'c1' };
    const cleanup = vi.fn(async () => {});

    await expect(
      withLateResultCleanup(Promise.resolve(created), 'browser.newContext', 1_000, cleanup),
    ).resolves.toBe(created);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('closes a context that arrives after the timeout', async () => {
    // The creation of a context outlasts the bound of the operation: the
    // client never learns its id, and nobody can close it any more.
    let resolveCreation: (value: { id: string }) => void = () => {};
    const creation = new Promise<{ id: string }>((resolve) => {
      resolveCreation = resolve;
    });
    const closed: string[] = [];
    const cleanup = vi.fn(async (context: { id: string }) => {
      closed.push(context.id);
    });

    await expect(
      withLateResultCleanup(creation, 'browser.newContext', 20, cleanup),
    ).rejects.toThrow(OperationTimeoutError);
    expect(cleanup).not.toHaveBeenCalled();

    // The context arrives after the timeout: it is closed, not registered.
    resolveCreation({ id: 'c1' });
    await vi.waitFor(() => expect(closed).toEqual(['c1']));
  });

  it('does not fail when the creation fails after the timeout', async () => {
    let rejectCreation: (error: Error) => void = () => {};
    const creation = new Promise<{ id: string }>((_resolve, reject) => {
      rejectCreation = reject;
    });
    const cleanup = vi.fn(async () => {});

    await expect(
      withLateResultCleanup(creation, 'browser.newContext', 20, cleanup),
    ).rejects.toThrow(OperationTimeoutError);

    rejectCreation(new Error('the browser is gone'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('InvalidatedHandles', () => {
  it('refuses a handle after the invalidation', () => {
    const handles = new InvalidatedHandles();

    expect(handles.isInvalidated('page', 'p1')).toBe(false);
    handles.invalidate('page', 'p1');
    expect(handles.isInvalidated('page', 'p1')).toBe(true);
    // The context of the same id is a different session.
    expect(handles.isInvalidated('context', 'p1')).toBe(false);
  });
});
