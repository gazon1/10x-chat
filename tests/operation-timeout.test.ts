import { describe, expect, it, vi } from 'vitest';
import {
  InvalidatedHandles,
  invalidatedHandle,
  invalidateOnTimeout,
  OperationTimeoutError,
  withOperationTimeout,
} from '../src/browser/operation-timeout.js';

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
