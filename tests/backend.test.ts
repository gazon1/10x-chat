import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AiBackend,
  BackendError,
  type BackendFailureKind,
  type BackendRequest,
  backendFailureKind,
  createFakeBackend,
  getBackend,
  listBackends,
  registerBackend,
  resetBackends,
} from '../src/backend/index.js';
import { runChat } from '../src/core/orchestrator.js';
import { getSession } from '../src/session/index.js';

describe('Backend contract', () => {
  it('does not depend on the browser implementation', async () => {
    const source = await readFile(new URL('../src/backend/contract.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/playwright/i);
    expect(source).not.toMatch(/\b(Page|Locator|BrowserContext)\b/);
    expect(source).not.toMatch(/\.(locator|evaluate|innerHTML|content)\(/);
  });

  it('keeps the request id and the conversation id', async () => {
    const backend = createFakeBackend();
    const outcome = await backend.ask({
      requestId: 'req-1',
      prompt: 'hello',
      conversationId: 'conv-9',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.requestId).toBe('req-1');
    expect(outcome.value.conversationId).toBe('conv-9');
    expect(outcome.value.submission).toBe('submitted');
  });
});

describe('Fake backend', () => {
  it('answers deterministically', async () => {
    const backend = createFakeBackend([{ prompt: 'hello', answer: 'Hi there' }]);
    const first = await backend.ask({ requestId: 'a', prompt: 'hello' });
    const second = await backend.ask({ requestId: 'a', prompt: 'hello' });
    expect(first).toEqual(second);
    if (!first.ok) return;
    expect(first.value.text).toBe('Hi there');
  });

  it('answers a prompt without a rule', async () => {
    const backend = createFakeBackend();
    const outcome = await backend.ask({ requestId: 'a', prompt: 'anything' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.text).toContain('anything');
  });

  it('marks a cut-off answer as truncated', async () => {
    const backend = createFakeBackend([{ prompt: 'long', answer: 'half', truncated: true }]);
    const outcome = await backend.ask({ requestId: 'a', prompt: 'long' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.truncated).toBe(true);
  });

  it('reports the state of a request', async () => {
    const backend = createFakeBackend();
    const unknown = await backend.status('never-asked');
    expect(unknown.submission).toBe('not_submitted');

    await backend.ask({ requestId: 'req-1', prompt: 'hello' });
    const known = await backend.status('req-1');
    expect(known.submission).toBe('submitted');
    expect(known.text).toContain('hello');
  });

  it('resumes a request and refuses an unknown one', async () => {
    const backend = createFakeBackend();
    await backend.ask({ requestId: 'req-1', prompt: 'hello' });

    const resumed = await backend.resume({ requestId: 'req-1', prompt: 'hello' });
    expect(resumed.ok).toBe(true);

    const unknown = await backend.resume({ requestId: 'nope', prompt: 'hello' });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.failure.kind).toBe('unknown_submission');
  });

  it('cancels a running request and refuses an unknown one', async () => {
    const backend = createFakeBackend();

    const running = backend.ask({ requestId: 'req-1', prompt: 'hello' });
    const cancelled = await backend.cancel('req-1');
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.cancelled).toBe(true);
    expect((await backend.status('req-1')).cancelled).toBe(true);

    const outcome = await running;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('cancelled');

    const unknown = await backend.cancel('nope');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.failure.kind).toBe('unknown_submission');
  });

  it('does not cancel a request that has already answered', async () => {
    const backend = createFakeBackend();
    await backend.ask({ requestId: 'req-1', prompt: 'hello' });

    const cancelled = await backend.cancel('req-1');
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.cancelled).toBe(false);
    expect((await backend.status('req-1')).cancelled).toBe(false);
  });

  it('keeps the submission state of a failed request', async () => {
    const backend = createFakeBackend([{ prompt: 'boom', failure: 'timeout' }]);
    await backend.ask({ requestId: 'req-1', prompt: 'boom' });
    const status = await backend.status('req-1');
    expect(status.submission).toBe('submitted');
    expect(status.text).toBeUndefined();
  });

  it('keeps the submission state of every failure in the status', async () => {
    const kinds: BackendFailureKind[] = [
      'busy',
      'unavailable',
      'timeout',
      'invalid_output',
      'cancelled',
      'unknown_submission',
    ];
    for (const kind of kinds) {
      const backend = createFakeBackend([{ prompt: 'boom', failure: kind }]);
      const outcome = await backend.ask({ requestId: 'req-1', prompt: 'boom' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      const status = await backend.status('req-1');
      expect(status.submission).toBe(outcome.failure.submission);
    }
  });

  it('resumes the recorded request and never sends a new prompt', async () => {
    const backend = createFakeBackend([{ prompt: 'first task', answer: 'the first answer' }]);
    await backend.ask({ requestId: 'req-1', prompt: 'first task' });
    const resumed = await backend.resume({ requestId: 'req-1', prompt: 'second task' });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.text).toBe('the first answer');
  });

  it('reports an unknown submission when it cannot resume a request', async () => {
    const backend = createFakeBackend();
    const outcome = await backend.resume({ requestId: 'nope', prompt: 'hello' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unknown_submission');
    expect(outcome.failure.submission).toBe('unknown');
  });

  it('recovers a failed request with a resume', async () => {
    const backend = createFakeBackend([
      { prompt: 'boom', failure: 'timeout', resume: { answer: 'the recovered answer' } },
    ]);
    const failed = await backend.ask({ requestId: 'req-1', prompt: 'boom' });
    expect(failed.ok).toBe(false);

    const resumed = await backend.resume({ requestId: 'req-1', prompt: 'boom' });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.text).toBe('the recovered answer');
    expect((await backend.status('req-1')).submission).toBe('submitted');
  });

  it('maps every failure kind and never answers with an empty success', async () => {
    const kinds: BackendFailureKind[] = [
      'busy',
      'unavailable',
      'timeout',
      'invalid_output',
      'cancelled',
      'unknown_submission',
    ];
    const expectedSubmission: Record<BackendFailureKind, string> = {
      busy: 'not_submitted',
      unavailable: 'not_submitted',
      timeout: 'submitted',
      invalid_output: 'submitted',
      cancelled: 'submitted',
      unknown_submission: 'unknown',
    };

    for (const kind of kinds) {
      const backend = createFakeBackend([{ prompt: 'boom', failure: kind, partial: 'half' }]);
      const outcome = await backend.ask({ requestId: 'req-1', prompt: 'boom' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.kind).toBe(kind);
      expect(outcome.failure.submission).toBe(expectedSubmission[kind]);
      expect(outcome.failure.partialText).toBe('half');
      expect(outcome.failure.message.length).toBeGreaterThan(0);
    }
  });
});

describe('Backend registry', () => {
  afterEach(() => {
    resetBackends();
  });

  it('registers the fake backend from the start', () => {
    expect(listBackends()).toContain('fake');
    expect(getBackend('fake').name).toBe('fake');
  });

  it('registers and replaces a backend by name', () => {
    const backend = createFakeBackend();
    registerBackend(backend);
    registerBackend(createFakeBackend());
    expect(getBackend('fake')).not.toBe(backend);
  });

  it('throws for an unknown backend', () => {
    expect(() => getBackend('nope')).toThrow('Unknown backend');
  });
});

describe('Chat through the backend contract', () => {
  const originalEnv = process.env;
  let tempHome = '';

  /** A fake backend that records the requests it receives. */
  const recordingBackend = (requests: BackendRequest[]): AiBackend => {
    const base = createFakeBackend();
    return {
      ...base,
      ask: async (request) => {
        requests.push(request);
        return base.ask(request);
      },
    };
  };

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-backend-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('answers without a browser', async () => {
    const backend = createFakeBackend([{ prompt: 'hello', answer: 'Hi there' }]);
    const result = await runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend });
    expect(result.response).toBe('Hi there');
    expect(result.truncated).toBe(false);
    expect(result.sessionId).toBeTruthy();

    const session = await getSession(result.sessionId);
    expect(session.meta.status).toBe('completed');
  });

  it('fails the run when the backend fails', async () => {
    const backend = createFakeBackend([{ prompt: 'boom', failure: 'timeout' }]);
    await expect(runChat({ prompt: 'boom', provider: 'chatgpt' }, { backend })).rejects.toThrow(
      BackendError,
    );
  });

  it('passes the timeout of the config file to the backend', async () => {
    await writeFile(
      path.join(tempHome, 'config.json'),
      JSON.stringify({
        defaultProvider: 'chatgpt',
        headless: true,
        profileMode: 'shared',
        defaultTimeoutMs: 30_000,
      }),
    );
    const requests: BackendRequest[] = [];
    const backend = recordingBackend(requests);

    await runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend });
    expect(requests[0].timeoutMs).toBe(30_000);

    await runChat({ prompt: 'hello', provider: 'chatgpt', timeoutMs: 5_000 }, { backend });
    expect(requests[1].timeoutMs).toBe(5_000);
  });

  it('fails the session when the backend throws', async () => {
    const backend = createFakeBackend();
    const broken = {
      ...backend,
      ask: async () => {
        throw new Error('the backend exploded');
      },
    };
    await expect(
      runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend: broken }),
    ).rejects.toThrow('the backend exploded');
  });

  it('rejects the browser flags — a backend run uses no browser', async () => {
    const backend = createFakeBackend();
    await expect(
      runChat({ prompt: 'hello', provider: 'chatgpt', headed: true }, { backend }),
    ).rejects.toThrow('does not use a browser');
  });

  it('rejects a capability the backend does not have', async () => {
    const backend = createFakeBackend();
    const limited = { ...backend, capabilities: { ...backend.capabilities, attachments: false } };
    await expect(
      runChat({ prompt: 'hello', provider: 'chatgpt', attach: ['a.png'] }, { backend: limited }),
    ).rejects.toThrow('does not support attachments');
  });

  it('fails the run when the backend answers with an empty response', async () => {
    const backend = createFakeBackend([{ prompt: 'hello', answer: '   ' }]);
    const error = await runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(backendFailureKind(error)).toBe('invalid_output');
  });

  it('fails the run when the backend answers another request', async () => {
    const base = createFakeBackend();
    const backend: AiBackend = {
      ...base,
      ask: async (request) => {
        const outcome = await base.ask(request);
        if (!outcome.ok) return outcome;
        return { ok: true as const, value: { ...outcome.value, requestId: 'another-request' } };
      },
    };
    const error = await runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(backendFailureKind(error)).toBe('invalid_output');
  });

  it('gives a streaming backend the channel of the answer', async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const base = createFakeBackend();
      const backend: AiBackend = {
        ...base,
        capabilities: { ...base.capabilities, streaming: true },
        ask: async (request) => {
          request.onChunk?.('first ');
          request.onChunk?.('second');
          return base.ask(request);
        },
      };
      await runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend });
    } finally {
      write.mockRestore();
    }
    expect(written.join('')).toContain('first second');
  });
});
