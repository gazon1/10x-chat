import { describe, expect, it } from 'vitest';
import {
  createChatgptUseBackend,
  type ProcessResult,
  type ProcessRunner,
} from '../src/backend/chatgpt-use.js';

interface Call {
  command: string;
  args: string[];
}

/** A runner that answers with canned envelopes and records the calls. */
function fakeRunner(answers: (ProcessResult | Error)[]): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    run: async (command, args) => {
      calls.push({ command, args });
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
});
