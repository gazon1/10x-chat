/**
 * The one path of the plain ChatGPT chat.
 *
 * `chat --provider chatgpt` and `chat --backend chatgpt-use` must reach the
 * same implementation — the backend of `chatgpt-use` — and the observable
 * result of the same scenario must be the same on both. The scene of every
 * scenario is a stub of the CLI, registered as the command of the backend, so
 * the run goes through the real adapter and the real application side of the
 * seam; only the CLI itself is replaced.
 *
 * The other side is covered too: the provider whose plain chat has no backend
 * keeps the browser path, and a stored conversation the backend cannot
 * continue is refused and named, never dropped silently.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackendError,
  createChatgptUseBackend,
  nodeProcessRunner,
  plainChatBackend,
  registerBackend,
  resetBackends,
} from '../src/backend/index.js';
import {
  getStoredConversation,
  resolveConversationContext,
  saveStoredConversation,
} from '../src/core/conversations.js';
import { runChat, wantsBrowser } from '../src/core/orchestrator.js';
import { getSession } from '../src/session/index.js';

/** A `chatgpt-use` that writes a canned stdout — the scene of a test. */
async function stubCli(stdout: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-parity-cli-'));
  const stub = path.join(dir, 'chatgpt-use');
  // A node script, not a shell one: the envelope is written byte for byte.
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      'const id = process.argv[process.argv.indexOf("--request-id") + 1] ?? "";',
      `process.stdout.write(${JSON.stringify(stdout)}.replaceAll("REQUEST_ID", id));`,
      '',
    ].join('\n'),
  );
  await chmod(stub, 0o755);
  return stub;
}

const envelope = (fields: Record<string, unknown>): string =>
  JSON.stringify({ request_id: 'REQUEST_ID', conversation_id: 'conv-parity', ...fields });

const COMPLETED = envelope({ status: 'completed', result: { text: 'the same answer' } });

const BUSY = envelope({
  status: 'busy',
  error: { kind: 'busy', message: 'another run uses the window', submitted: 'no' },
});

const CUT_OFF = envelope({
  status: 'incomplete',
  error: { kind: 'incomplete', message: 'the answer was cut off', submitted: 'yes' },
});

/** An answer that arrived empty: the request ran, the answer is unusable. */
const EMPTY = envelope({ status: 'completed', result: { text: '   ' } });

/** The backend of a stub: the command of the run is the stub itself. */
const stubBackend = (command: string) => createChatgptUseBackend({ command });

/** The settled outcome of a run — a failure is a value, not a swallow. */
const settle = (run: Promise<unknown>) =>
  run.then(
    () => 'answered',
    (error: unknown) => error,
  );

/** The typed failure of a settled run. */
function failureOf(settled: unknown): BackendError {
  expect(settled).toBeInstanceOf(BackendError);
  return settled as BackendError;
}

describe('the plain chat of ChatGPT has one path', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-parity-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    resetBackends();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetBackends();
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  /** Register the stub as the chatgpt backend of the registry. */
  async function useStub(stdout: string): Promise<void> {
    registerBackend(stubBackend(await stubCli(stdout)), 'chatgpt');
  }

  it('serves chatgpt through its backend and leaves the others alone', () => {
    expect(plainChatBackend('chatgpt')?.name).toBe('chatgpt-use');
    expect(plainChatBackend('gemini')).toBeUndefined();
    expect(plainChatBackend('claude')).toBeUndefined();
    expect(plainChatBackend('deepseek')).toBeUndefined();
  });

  it('keeps the browser when the run names the browser transport', () => {
    // `--transport browser` is the caller's choice of a transport: the backend
    // must not answer a run that named the browser, nor refuse it as if the
    // option did not apply.
    expect(wantsBrowser({ prompt: 'hello', transport: 'browser' })).toBe(true);
    // A run that names no transport keeps the backend.
    expect(wantsBrowser({ prompt: 'hello' })).toBe(false);
  });

  it('reaches the backend without --backend', async () => {
    // The stub is the only CLI of the run: an answer from it proves the
    // backend served a run that named no backend at all.
    await useStub(COMPLETED);
    const result = await runChat({ prompt: 'hello' });

    expect(result.response).toBe('the same answer');
    expect(result.backend).toBe('chatgpt-use');
    const session = await getSession(result.sessionId);
    expect(session.meta.backend).toBe('chatgpt-use');
  });

  it('answers the same through --provider and through --backend', async () => {
    await useStub(COMPLETED);

    const throughProvider = await runChat({ prompt: 'hello', provider: 'chatgpt' });
    const throughBackend = await runChat(
      { prompt: 'hello', provider: 'chatgpt' },
      { backend: stubBackend(await stubCli(COMPLETED)) },
    );

    expect(throughProvider.response).toBe(throughBackend.response);
    expect(throughProvider.provider).toBe(throughBackend.provider);
    expect(throughProvider.backend).toBe(throughBackend.backend);
    expect(throughProvider.truncated).toBe(throughBackend.truncated);
  });

  it('fails the same way when the window is busy', async () => {
    await useStub(BUSY);
    const settled = await Promise.all([
      settle(runChat({ prompt: 'hello', provider: 'chatgpt' })),
      settle(
        runChat(
          { prompt: 'hello', provider: 'chatgpt' },
          { backend: stubBackend(await stubCli(BUSY)) },
        ),
      ),
    ]);

    for (const failure of settled.map(failureOf)) {
      expect(failure.failure.kind).toBe('busy');
      // The prompt never reached the model: it may be sent again.
      expect(failure.failure.submission).toBe('not_submitted');
    }
  });

  it('fails the same way when the answer is cut off', async () => {
    await useStub(CUT_OFF);
    const settled = await Promise.all([
      settle(runChat({ prompt: 'hello', provider: 'chatgpt' })),
      settle(
        runChat(
          { prompt: 'hello', provider: 'chatgpt' },
          { backend: stubBackend(await stubCli(CUT_OFF)) },
        ),
      ),
    ]);

    for (const failure of settled.map(failureOf)) {
      expect(failure.failure.kind).toBe('timeout');
      // The request did reach the model: it must not be sent again.
      expect(failure.failure.submission).toBe('submitted');
    }
  });

  it('fails the same way on an empty answer — never an empty success', async () => {
    await useStub(EMPTY);
    const settled = await Promise.all([
      settle(runChat({ prompt: 'hello', provider: 'chatgpt' })),
      settle(
        runChat(
          { prompt: 'hello', provider: 'chatgpt' },
          { backend: stubBackend(await stubCli(EMPTY)) },
        ),
      ),
    ]);

    for (const failure of settled.map(failureOf)) {
      expect(failure.failure.kind).toBe('invalid_output');
    }
  });

  it('fails the same way when the CLI is not installed', async () => {
    // A command that is not there: the two paths must agree on the failure.
    const missing = path.join(tempHome, 'no-such-chatgpt-use');
    registerBackend(
      createChatgptUseBackend({ command: missing, runner: nodeProcessRunner }),
      'chatgpt',
    );
    const settled = await Promise.all([
      settle(runChat({ prompt: 'hello', provider: 'chatgpt' })),
      settle(
        runChat(
          { prompt: 'hello', provider: 'chatgpt' },
          { backend: createChatgptUseBackend({ command: missing, runner: nodeProcessRunner }) },
        ),
      ),
    ]);

    for (const failure of settled.map(failureOf)) {
      expect(failure.failure.kind).toBe('unavailable');
      expect(failure.failure.submission).toBe('not_submitted');
    }
  });
});

describe('the conversation a backend cannot continue', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-reuse-loss-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    resetBackends();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetBackends();
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  /** Store a conversation of this repository and branch for chatgpt. */
  async function storeConversation(): Promise<void> {
    await saveStoredConversation(await resolveConversationContext(), 'chatgpt', {
      id: 'abc',
      url: 'https://chatgpt.com/c/abc',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  /** Capture what the run prints. */
  async function printed(fn: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await fn();
    } finally {
      console.log = log;
    }
    return lines.join('\n');
  }

  it('is refused with a typed failure — never a silent new chat', async () => {
    let started = 0;
    const counting = createChatgptUseBackend({
      runner: {
        run: async () => {
          started++;
          return { code: 0, stdout: COMPLETED, stderr: '', timedOut: false };
        },
      },
    });

    const outcome = await counting.ask({
      requestId: 'req-1',
      prompt: 'hello',
      conversationId: 'conv-existing',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('rejected');
    expect(outcome.failure.submission).toBe('not_submitted');
    expect(outcome.failure.message).toContain('conv-existing');
    // A refused request never touches the CLI.
    expect(started).toBe(0);
  });

  it('states the loss of a stored conversation instead of dropping it silently', async () => {
    await storeConversation();
    registerBackend(stubBackend(await stubCli(COMPLETED)), 'chatgpt');

    // The run still answers: the loss is named, not fatal.
    const output = await printed(async () => {
      const result = await runChat({ prompt: 'hello', provider: 'chatgpt' });
      expect(result.response).toBe('the same answer');
    });

    expect(output).toMatch(/cannot continue the chat abc/);
    // The retired entry is gone: the next run does not promise it again.
    expect(
      await getStoredConversation(await resolveConversationContext(), 'chatgpt'),
    ).toBeUndefined();
  });

  it('says nothing about a conversation when --new-chat was asked for', async () => {
    await storeConversation();
    registerBackend(stubBackend(await stubCli(COMPLETED)), 'chatgpt');

    const output = await printed(() =>
      runChat({ prompt: 'hello', provider: 'chatgpt', newChat: true }),
    );

    expect(output).not.toMatch(/cannot continue/);
  });

  it('keeps the stored conversation of a provider whose browser path still reuses it', async () => {
    // An opt-in backend is a second path beside the browser: the perplexity
    // conversation belongs to the browser run, which can still reopen it. Only
    // the backend that serves the provider's plain chat may retire it.
    const context = await resolveConversationContext();
    await saveStoredConversation(context, 'perplexity', {
      id: 'perplexity-chat',
      url: 'https://www.perplexity.ai/search/perplexity-chat',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    registerBackend(stubBackend(await stubCli(COMPLETED)), 'perplexity');
    const optIn = stubBackend(await stubCli(COMPLETED));

    const output = await printed(() =>
      runChat({ prompt: 'hello', provider: 'perplexity' }, { backend: optIn }),
    );

    expect(output).not.toMatch(/cannot continue/);
    expect(await getStoredConversation(context, 'perplexity')).toBeDefined();
  });

  it('states the same loss through --backend as through --provider', async () => {
    // The two ways into the backend must be observably the same: the message
    // is not a property of the routing, it is a property of the backend run.
    const throughProvider = async () => {
      await storeConversation();
      registerBackend(stubBackend(await stubCli(COMPLETED)), 'chatgpt');
      return printed(() => runChat({ prompt: 'hello', provider: 'chatgpt' }));
    };
    const throughBackend = async () => {
      await storeConversation();
      const stub = stubBackend(await stubCli(COMPLETED));
      return printed(() => runChat({ prompt: 'hello', provider: 'chatgpt' }, { backend: stub }));
    };

    expect(await throughProvider()).toMatch(/cannot continue the chat abc/);
    expect(await throughBackend()).toMatch(/cannot continue the chat abc/);
  });
});
