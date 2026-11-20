import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_USE_BACKEND_NAME,
  createChatgptUseBackend,
  nodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from '../src/backend/chatgpt-use.js';
import { providerOfBackend } from '../src/backend/registry.js';

interface Call {
  command: string;
  args: string[];
  timeoutMs?: number;
  input?: string;
}

/** A runner that answers with canned envelopes and records the calls. */
function fakeRunner(answers: (ProcessResult | Error)[]): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    run: async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options?.timeoutMs, input: options?.input });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? { code: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
  return { runner, calls };
}

/** The envelope of a completed answer. */
function completed(text: string, requestId = 'req-1'): string {
  return JSON.stringify({
    status: 'completed',
    request_id: requestId,
    conversation_id: 'conv-1',
    result: { text },
  });
}

/** The envelope of a failure. */
function failed(kind: string, submitted: string, message = 'boom'): string {
  return JSON.stringify({
    status: kind,
    request_id: 'req-1',
    error: { kind, message, submitted },
  });
}

const request = {
  requestId: 'req-1',
  prompt: 'hello',
};

describe('the ChatGPT backend of chatgpt-use', () => {
  it('parses a completed answer', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('the answer'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.text).toBe('the answer');
    expect(outcome.value.conversationId).toBe('conv-1');
    expect(outcome.value.submission).toBe('submitted');
    expect(outcome.value.truncated).toBe(false);
    expect(outcome.value.requestId).toBe('req-1');
    // The CLI is called without a shell: the prompt is a plain argument.
    expect(calls[0]?.command).toBe('chatgpt-use');
    expect(calls[0]?.args).toContain('--json');
    expect(calls[0]?.args).toContain('req-1');
    expect(calls[0]?.args.at(-1)).toBe('hello');
  });

  it('maps a busy answer to a busy failure', async () => {
    const { runner } = fakeRunner([
      { code: 7, stdout: failed('busy', 'no'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('busy');
    expect(outcome.failure.submission).toBe('not_submitted');
  });

  it('maps an unavailable answer to an unavailable failure', async () => {
    const { runner } = fakeRunner([
      { code: 1, stdout: failed('login_required', 'no'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unavailable');
    expect(outcome.failure.submission).toBe('not_submitted');
  });

  it('maps an interrupted answer to a timeout failure', async () => {
    const { runner } = fakeRunner([
      { code: 5, stdout: failed('incomplete', 'yes'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('timeout');
    expect(outcome.failure.submission).toBe('submitted');
  });

  it('never sends a request twice when the CLI reports a duplicate', async () => {
    const { runner, calls } = fakeRunner([
      { code: 9, stdout: failed('duplicate_request', 'yes'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
    expect(calls).toHaveLength(1);
  });

  it('surfaces an unknown submission state and does not retry it', async () => {
    const { runner, calls } = fakeRunner([
      { code: 1, stdout: failed('submit_unknown', 'unknown'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unknown_submission');
    expect(outcome.failure.submission).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('rejects an answer that is not an envelope', async () => {
    const { runner } = fakeRunner([
      { code: 0, stdout: 'not json', stderr: 'it broke', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects an envelope without a status and without an error', async () => {
    const { runner } = fakeRunner([
      { code: 0, stdout: JSON.stringify({ request_id: 'req-1' }), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects a completed answer without a text', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'completed', request_id: 'req-1', result: {} }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects the answer of another request', async () => {
    const { runner } = fakeRunner([
      { code: 0, stdout: completed('the answer', 'other-request'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('reports a CLI that cannot be started as unavailable', async () => {
    const { runner } = fakeRunner([new Error('spawn chatgpt-use ENOENT')]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unavailable');
    expect(outcome.failure.submission).toBe('not_submitted');
  });

  it('sends the attachments as context and the images as images', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    await backend.ask({
      ...request,
      attachments: ['/tmp/notes.md', '/tmp/shot.png'],
      model: 'Pro',
      timeoutMs: 90_000,
    });

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--file');
    expect(args).toContain('/tmp/notes.md');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/shot.png');
    // The level of the composer, not the name of the model of the browser.
    expect(args[args.indexOf('--model') + 1]).toBe('pro');
    expect(args[args.indexOf('--timeout') + 1]).toBe('90');
  });

  it('resumes a request without sending the prompt again', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('the rest'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.resume(request);

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args[0]).toBe('resume');
    expect(calls[0]?.args).toContain('req-1');
    expect(calls[0]?.args).not.toContain('hello');
  });

  it('reports the state of a request from its receipt', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({
          request_id: 'req-1',
          state: 'completed',
          submitted: 'yes',
          conversation_id: 'conv-1',
          outcome: 'completed',
          error: null,
        }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const state = await backend.status('req-1');

    expect(state.submission).toBe('submitted');
    expect(state.conversationId).toBe('conv-1');
    expect(state.cancelled).toBeUndefined();
  });

  it('reports a request without a receipt as not submitted', async () => {
    const { runner } = fakeRunner([
      {
        code: 1,
        stdout: '',
        stderr: 'error: no receipt for request "req-1"',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const state = await backend.status('req-1');

    expect(state.submission).toBe('not_submitted');
  });

  it('cancels a running request and leaves a finished one alone', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'cancelled', request_id: 'req-1', submitted: 'yes' }),
        stderr: '',
        timedOut: false,
      },
      {
        code: 0,
        stdout: JSON.stringify({ status: 'already_finished', request_id: 'req-1' }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const cancelled = await backend.cancel('req-1');
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.value.cancelled).toBe(true);

    const finished = await backend.cancel('req-1');
    expect(finished.ok).toBe(true);
    if (finished.ok) expect(finished.value.cancelled).toBe(false);
  });

  it('runs one ask at a time', async () => {
    let running = 0;
    let peak = 0;
    const runner: ProcessRunner = {
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { code: 0, stdout: completed('ok'), stderr: '', timedOut: false };
      },
    };
    const backend = createChatgptUseBackend({ runner });

    await Promise.all([backend.ask(request), backend.ask({ ...request, requestId: 'req-2' })]);

    expect(peak).toBe(1);
  });

  it('builds the whole command line of a request', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    await backend.ask({
      requestId: 'req-1',
      prompt: '-a prompt that starts with a dash',
      model: 'Pro',
      attachments: ['/tmp/notes.md', '/tmp/shot.png'],
      timeoutMs: 90_000,
    });

    expect(calls[0]?.args).toEqual([
      'ask',
      '--json',
      '--request-id',
      'req-1',
      '--busy',
      'fail',
      '--no-stdin',
      '--model',
      'pro',
      '--timeout',
      '90',
      '--file',
      '/tmp/notes.md',
      '--image',
      '/tmp/shot.png',
      '--',
      '-a prompt that starts with a dash',
    ]);
    // The deadline of the CLI is the deadline of the chat, plus the backstop
    // for the parts around it.
    expect(calls[0]?.timeoutMs).toBe(150_000);
  });

  it('sends a prompt that does not fit into an argument through the stdin', async () => {
    // The kernel of Linux limits one argument of a process to 128 KiB and the
    // command line of Windows to 32 767 characters: a bigger prompt is refused
    // before the CLI sees it. The bundle of a review of a big change is bigger
    // than that.
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });
    const prompt = 'x'.repeat(200_000);

    const outcome = await backend.ask({ requestId: 'req-1', prompt });

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args).toContain('--stdin');
    expect(calls[0]?.args).not.toContain(prompt);
    expect(calls[0]?.input).toBe(prompt);
  });

  it('keeps a prompt that fits into an argument an argument', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });
    const prompt = 'x'.repeat(29_000);

    await backend.ask({ requestId: 'req-1', prompt });

    expect(calls[0]?.args).toContain('--no-stdin');
    expect(calls[0]?.args).toContain(prompt);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not crash when the process dies before it reads the input', async () => {
    // The broken pipe of a process that died is an error of the stream: it
    // must not become an unhandled error of the run.
    const result = await nodeProcessRunner.run(process.execPath, ['-e', 'process.exit(0);'], {
      input: 'x'.repeat(1_000_000),
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it('gives two different requests two different receipts', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
      { code: 0, stdout: completed('ok', 'task_3Fa'), stderr: '', timedOut: false },
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    await backend.ask({ requestId: 'task/a', prompt: 'hello' });
    await backend.ask({ requestId: 'task?a', prompt: 'hello' });
    await backend.ask({ requestId: 'task_3Fa', prompt: 'hello' });

    const ids = calls.map((call) => call.args[call.args.indexOf('--request-id') + 1]);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects a completed answer without the id of the request', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'completed', result: { text: 'the answer' } }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects a completed answer whose id is not a string', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'completed', request_id: 7, result: { text: 'ok' } }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects the cancellation of another request', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'cancelled', request_id: 'other-request' }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.cancel('req-1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects a cancellation without the id of the request', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({ status: 'cancelled', submitted: 'yes' }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.cancel('req-1');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('rejects the receipt of another request', async () => {
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({
          request_id: 'other-request',
          state: 'completed',
          submitted: 'yes',
        }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const state = await backend.status('req-1');

    expect(state.submission).toBe('unknown');
  });

  it('reports a request the CLI never heard of as not submitted', async () => {
    const { runner } = fakeRunner([
      {
        code: 1,
        stdout: '',
        stderr: 'error: no receipt for request "req-1"',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.resume(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The request was never submitted: it is safe to send it again.
    expect(outcome.failure.submission).toBe('not_submitted');
  });

  it('gives an empty request id a receipt of its own', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    await backend.ask({ requestId: '', prompt: 'hello' });
    await backend.ask({ requestId: 'request', prompt: 'hello' });

    const ids = calls.map((call) => call.args[call.args.indexOf('--request-id') + 1]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('reports a CLI that does not finish in time as an unknown submission', async () => {
    const { runner, calls } = fakeRunner([{ code: null, stdout: '', stderr: '', timedOut: true }]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unknown_submission');
    expect(outcome.failure.submission).toBe('unknown');
    // The request may have reached ChatGPT: it is never sent again.
    expect(calls).toHaveLength(1);
  });

  it('maps an unknown kind of the CLI to an invalid output', async () => {
    const { runner } = fakeRunner([
      { code: 1, stdout: failed('something_new', 'yes'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
  });

  it('kills a process that ignores the termination', async () => {
    const started = Date.now();
    const result = await nodeProcessRunner.run(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { timeoutMs: 200 },
    );

    expect(result.timedOut).toBe(true);
    // The grace period is short: the run must not stay pending.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('collects the output of a process and its exit code', async () => {
    const result = await nodeProcessRunner.run(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
    ]);

    // The stdout of the CLI stays machine-readable: the diagnostics come
    // from the stderr.
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('reports a command that cannot be started', async () => {
    await expect(
      nodeProcessRunner.run('chatgpt-use-does-not-exist-either', ['ask']),
    ).rejects.toThrow();
  });

  it('keeps the hash of an id out of the namespace of the ordinary ids', async () => {
    // The receipt of the empty id is the hash of it — an ordinary id that is
    // the hash itself must not land on the same receipt.
    const digest = createHash('sha256').update('').digest('hex');
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    await backend.ask({ requestId: '', prompt: 'hello' });
    await backend.ask({ requestId: digest, prompt: 'hello' });

    const ids = calls.map((call) => call.args[call.args.indexOf('--request-id') + 1]);
    expect(ids[0]).not.toBe(ids[1]);
    // The CLI accepts letters, digits, `.`, `_` and `-` (up to 128).
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    }
  });

  it('is registered with the provider it drives', () => {
    expect(providerOfBackend(CHATGPT_USE_BACKEND_NAME)).toBe('chatgpt');
  });
});
