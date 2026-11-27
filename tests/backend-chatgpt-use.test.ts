import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_USE_BACKEND_NAME,
  conversationHrefMatches,
  createChatgptUseBackend,
  isProjectChatsListAnchor,
  nodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  projectChatsListDomPredicate,
  readChatgptUseProjects,
  resolveChatgptProject,
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

  it('does not pass --project when chatgptProject is unconfigured', async () => {
    const { runner, calls } = fakeRunner([
      { code: 0, stdout: completed('ok'), stderr: '', timedOut: false },
    ]);
    const backend = createChatgptUseBackend({ runner });

    const outcome = await backend.ask(request);

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args ?? []).not.toContain('--project');
  });

  it('passes --project and verifies membership for a configured project', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(
      projectsPath,
      JSON.stringify({ 'chatgpt-use': 'g-p-6afee1f89d048191922c5b25247b5a95' }),
      'utf8',
    );
    const verifications: Array<{ conversationId: string; project: { name: string; id: string } }> =
      [];
    const { runner, calls } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({
          status: 'completed',
          request_id: 'req-1',
          conversation_id: 'conv-1',
          result: { text: 'ok' },
        }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({
      runner,
      projectsPath,
      verifyProjectMembership: async (conversationId, project) => {
        verifications.push({ conversationId, project });
        return undefined;
      },
    });

    const outcome = await backend.ask({ ...request, chatgptProject: 'chatgpt-use' });

    expect(outcome.ok).toBe(true);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf('--project') + 1]).toBe('chatgpt-use');
    expect(verifications).toEqual([
      {
        conversationId: 'conv-1',
        project: { name: 'chatgpt-use', id: 'g-p-6afee1f89d048191922c5b25247b5a95' },
      },
    ]);
  });

  it('fails explicitly and does not run the CLI when the configured project is unresolved', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(
      projectsPath,
      JSON.stringify({ 'chatgpt-use': 'g-p-6afee1f89d048191922c5b25247b5a95' }),
      'utf8',
    );
    const { runner, calls } = fakeRunner([]);
    const backend = createChatgptUseBackend({ runner, projectsPath });

    const outcome = await backend.ask({ ...request, chatgptProject: 'typo-project' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('rejected');
    expect(outcome.failure.submission).toBe('not_submitted');
    expect(outcome.failure.message).toContain('typo-project');
    expect(outcome.failure.message).toContain(projectsPath);
    expect(outcome.failure.message).toContain('would make chatgpt-use create a project');
    expect(calls).toHaveLength(0);
  });

  it('fails the membership check when the conversation is not in the project list', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(
      projectsPath,
      JSON.stringify({ 'chatgpt-use': 'g-p-6afee1f89d048191922c5b25247b5a95' }),
      'utf8',
    );
    const { runner } = fakeRunner([
      {
        code: 0,
        stdout: JSON.stringify({
          status: 'completed',
          request_id: 'req-1',
          conversation_id: 'conv-1',
          result: { text: 'ok' },
        }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const backend = createChatgptUseBackend({
      runner,
      projectsPath,
      verifyProjectMembership: async () => ({
        kind: 'invalid_output',
        message: 'conversation not in project Chats list after reload',
        submission: 'submitted',
      }),
    });

    const outcome = await backend.ask({ ...request, chatgptProject: 'chatgpt-use' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_output');
    expect(outcome.failure.submission).toBe('submitted');
    expect(outcome.failure.message).toContain('Chats list');
  });

  it('reads projects.json and resolves a configured project name', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(projectsPath, JSON.stringify({ 'chatgpt-use': 'g-p-1' }), 'utf8');

    await expect(readChatgptUseProjects(projectsPath)).resolves.toEqual({
      'chatgpt-use': 'g-p-1',
    });
    await expect(resolveChatgptProject('chatgpt-use', projectsPath)).resolves.toEqual({
      ok: true,
      value: { name: 'chatgpt-use', id: 'g-p-1' },
    });
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

  it('reports how long an ask waited for the queue', async () => {
    // The first process is held open by the test itself: no wall-clock sleep,
    // and the second ask provably waits behind it.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        const id = args[args.indexOf('--request-id') + 1] ?? 'req-1';
        // The answer names the request it answers, the way the CLI does.
        const answer = { code: 0, stdout: completed('ok', id), stderr: '', timedOut: false };
        if (id === 'req-1') await held;
        return answer;
      },
    };
    const backend = createChatgptUseBackend({ runner });

    const first = backend.ask(request);
    const second = backend.ask({ ...request, requestId: 'req-2' });
    // The second ask cannot start before the first one is released.
    release?.();
    const [one, two] = await Promise.all([first, second]);

    // The first ask found the queue empty; the second served a wait behind it
    // — and both say so, because only the queue knows when a request reached
    // the front. The wait is a measurement of the wall clock, so its size is
    // not asserted here: `withQueueWait` below is the arithmetic of it.
    expect(one.ok && one.value.queueWaitMs).toBe(0);
    expect(two.ok && typeof (two.ok ? two.value.queueWaitMs : undefined)).toBe('number');
    expect(two.ok && (two.value.queueWaitMs ?? -1)).toBeGreaterThanOrEqual(0);
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

  it('rejects inherited project names instead of resolving Object.prototype members', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(projectsPath, JSON.stringify({ 'chatgpt-use': 'g-p-1' }), 'utf8');

    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const outcome = await resolveChatgptProject(name, projectsPath);
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.failure.kind).toBe('rejected');
      expect(outcome.failure.submission).toBe('not_submitted');
      expect(outcome.failure.message).toContain(name);
    }
  });

  it('rejects an unresolved configured project even when the name exists on Object.prototype', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(projectsPath, JSON.stringify({}), 'utf8');
    const { runner, calls } = fakeRunner([]);
    const backend = createChatgptUseBackend({ runner, projectsPath });

    const outcome = await backend.ask({ ...request, chatgptProject: 'constructor' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('rejected');
    expect(outcome.failure.submission).toBe('not_submitted');
    expect(calls).toHaveLength(0);
  });

  it('treats project Chats anchors as membership evidence and ignores global navigation', () => {
    const origin = 'https://chatgpt.com';
    const cid = 'conv-1';

    expect(
      isProjectChatsListAnchor({ href: `/g/g-p-1/c/${cid}`, insideGlobalNav: false }, cid, origin),
    ).toBe(true);
    expect(
      isProjectChatsListAnchor({ href: `/g/g-p-1/c/${cid}`, insideGlobalNav: true }, cid, origin),
    ).toBe(false);
    expect(
      isProjectChatsListAnchor({ href: `/g/g-p-1/c/other`, insideGlobalNav: false }, cid, origin),
    ).toBe(false);
    expect(conversationHrefMatches(`https://chatgpt.com/g/g-p-1/c/${cid}`, cid, origin)).toBe(true);
  });

  it('does not treat a conversation id prefix as the same conversation', () => {
    const origin = 'https://chatgpt.com';
    expect(
      conversationHrefMatches('https://chatgpt.com/g/g-p-1/c/conv-123-extra', 'conv-123', origin),
    ).toBe(false);
    expect(conversationHrefMatches('https://chatgpt.com/g/g-p-1/c/conv-10', 'conv-1', origin)).toBe(
      false,
    );
    expect(
      conversationHrefMatches('https://chatgpt.com/g/g-p-1/c/conv-1?x=1', 'conv-1', origin),
    ).toBe(true);
    expect(
      conversationHrefMatches('https://chatgpt.com/g/g-p-1/c/conv-1#tail', 'conv-1', origin),
    ).toBe(true);
    expect(
      isProjectChatsListAnchor(
        { href: '/g/g-p-1/c/conv-123-extra', insideGlobalNav: false },
        'conv-123',
        origin,
      ),
    ).toBe(false);

    const originalDocument = (globalThis as { document?: unknown }).document;
    try {
      (globalThis as { document?: unknown }).document = {
        querySelectorAll: (selector: string) => {
          if (selector === 'main, [role="main"]')
            return [
              {
                querySelectorAll: () => [
                  {
                    href: 'https://chatgpt.com/g/g-p-1/c/conv-10',
                    closest: () => null,
                  },
                ],
              },
            ];
          if (selector === 'a[href*="/c/"]') return [];
          return [];
        },
      };
      expect(projectChatsListDomPredicate('conv-1')).toBe(false);
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  it('checks project Chats list anchors in main content before global navigation', () => {
    const cid = 'conv-1';
    const originalDocument = (globalThis as { document?: unknown }).document;
    const makeAnchor = (href: string, nav: boolean) => ({
      href,
      closest: (selector: string) => {
        if (!nav) return null;
        return selector.includes('nav') ? {} : null;
      },
    });
    const sidebarLink = makeAnchor(`https://chatgpt.com/c/${cid}`, true);
    const mainLink = makeAnchor(`https://chatgpt.com/g/g-p-1/c/${cid}`, false);
    try {
      (globalThis as { document?: unknown }).document = {
        querySelectorAll: (selector: string) => {
          if (selector === 'main, [role="main"]') return [{ querySelectorAll: () => [mainLink] }];
          if (selector === 'a[href*="/c/"]') return [sidebarLink, mainLink];
          return [];
        },
      };
      expect(projectChatsListDomPredicate(cid)).toBe(true);

      // Sidebar has the conversation, but main content does not: not a Chats-list hit.
      (globalThis as { document?: unknown }).document = {
        querySelectorAll: (selector: string) => {
          if (selector === 'main, [role="main"]') return [{ querySelectorAll: () => [] }];
          if (selector === 'a[href*="/c/"]') return [sidebarLink];
          return [];
        },
      };
      expect(projectChatsListDomPredicate(cid)).toBe(false);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  it('falls back to non-nav document anchors when main content is absent', () => {
    const cid = 'conv-1';
    const originalDocument = (globalThis as { document?: unknown }).document;
    const makeAnchor = (href: string, nav: boolean) => ({
      href,
      closest: (selector: string) => (nav && selector.includes('nav') ? {} : null),
    });
    try {
      (globalThis as { document?: unknown }).document = {
        querySelectorAll: (selector: string) => {
          if (selector === 'main, [role="main"]') return [];
          if (selector === 'a[href*="/c/"]')
            return [
              makeAnchor(`https://chatgpt.com/c/${cid}`, true),
              makeAnchor(`https://chatgpt.com/g/g-p-1/c/${cid}`, false),
            ];
          return [];
        },
      };
      expect(projectChatsListDomPredicate(cid)).toBe(true);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  it('verifies membership through the browser predicate: list match, sidebar-only miss, reload success, absent, browser failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(
      projectsPath,
      JSON.stringify({ 'chatgpt-use': 'g-p-6afee1f89d048191922c5b25247b5a95' }),
      'utf8',
    );

    const makeAnchor = (href: string, nav: boolean) => ({
      href,
      closest: (selector: string) => (nav && selector.includes('nav') ? {} : null),
    });
    const installDocument = (opts: {
      mainAnchors: Array<{ href: string; nav: boolean }>;
      docAnchors?: Array<{ href: string; nav: boolean }>;
    }) => {
      const main = {
        querySelectorAll: () => opts.mainAnchors.map((a) => makeAnchor(a.href, a.nav)),
      };
      (globalThis as { document?: unknown }).document = {
        querySelectorAll: (selector: string) => {
          if (selector === 'main, [role="main"]') return [main];
          if (selector === 'a[href*="/c/"]')
            return (opts.docAnchors ?? opts.mainAnchors).map((a) => makeAnchor(a.href, a.nav));
          return [];
        },
      };
    };

    const originalDocument = (globalThis as { document?: unknown }).document;
    const browserModule = await import('../src/browser/index.js');
    const providersModule = await import('../src/providers/index.js');
    let reloadCount = 0;
    let gotoCount = 0;
    let closeCount = 0;
    let onReload: () => void = () => {};
    const fakePage = {
      goto: async () => {
        gotoCount += 1;
      },
      reload: async () => {
        reloadCount += 1;
        onReload();
      },
      waitForTimeout: async () => {},
      evaluate: async (fn: (cid: string) => boolean, cid: string) => fn(cid),
    };
    const launchSpy = vi.spyOn(browserModule, 'launchBrowser').mockImplementation(
      async () =>
        ({
          page: fakePage,
          close: async () => {
            closeCount += 1;
          },
        }) as never,
    );
    const providerSpy = vi.spyOn(providersModule, 'getProvider').mockReturnValue({
      actions: { isLoggedIn: async () => true },
    } as never);

    try {
      // 1) Present before reload and after reload: primary post-reload signal passes.
      installDocument({
        mainAnchors: [{ href: 'https://chatgpt.com/g/g-p-1/c/conv-1', nav: false }],
      });
      onReload = () => {
        installDocument({
          mainAnchors: [{ href: 'https://chatgpt.com/g/g-p-1/c/conv-1', nav: false }],
        });
      };
      const backend1 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      await expect(
        backend1.ask({ ...request, chatgptProject: 'chatgpt-use' }),
      ).resolves.toMatchObject({ ok: true });
      expect(gotoCount).toBe(1);
      expect(reloadCount).toBe(1);

      // 1b) Visible before reload but absent after reload: fail, do not trust pre-reload DOM.
      installDocument({
        mainAnchors: [{ href: 'https://chatgpt.com/g/g-p-1/c/conv-1', nav: false }],
      });
      onReload = () => {
        installDocument({ mainAnchors: [], docAnchors: [] });
      };
      reloadCount = 0;
      const backend1b = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const preReloadOnly = await backend1b.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(preReloadOnly.ok).toBe(false);
      if (!preReloadOnly.ok) expect(preReloadOnly.failure.kind).toBe('invalid_output');
      expect(reloadCount).toBe(1);

      installDocument({
        mainAnchors: [],
        docAnchors: [{ href: 'https://chatgpt.com/c/conv-1', nav: true }],
      });
      onReload = () => {};
      reloadCount = 0;
      const backend2 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const sidebarOnly = await backend2.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(sidebarOnly.ok).toBe(false);
      if (!sidebarOnly.ok) expect(sidebarOnly.failure.kind).toBe('invalid_output');
      expect(reloadCount).toBe(1);

      installDocument({ mainAnchors: [] });
      reloadCount = 0;
      onReload = () => {
        installDocument({
          mainAnchors: [{ href: 'https://chatgpt.com/g/g-p-1/c/conv-1', nav: false }],
        });
      };
      const backend3 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      await expect(
        backend3.ask({ ...request, chatgptProject: 'chatgpt-use' }),
      ).resolves.toMatchObject({ ok: true });
      expect(reloadCount).toBe(1);
      onReload = () => {};

      installDocument({ mainAnchors: [], docAnchors: [] });
      const backend4 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const absent = await backend4.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.failure.kind).toBe('invalid_output');

      launchSpy.mockImplementationOnce(async () => {
        throw new Error('browser unavailable');
      });
      const backend5 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const browserFailure = await backend5.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(browserFailure.ok).toBe(false);
      if (!browserFailure.ok) {
        expect(browserFailure.failure.kind).toBe('unavailable');
        expect(browserFailure.failure.submission).toBe('submitted');
        expect(browserFailure.failure.message).toContain('browser unavailable');
      }

      providerSpy.mockReturnValueOnce({
        actions: { isLoggedIn: async () => false },
      } as never);
      const backend6 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const notLoggedIn = await backend6.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(notLoggedIn.ok).toBe(false);
      if (!notLoggedIn.ok) {
        expect(notLoggedIn.failure.kind).toBe('unavailable');
        expect(notLoggedIn.failure.submission).toBe('submitted');
        expect(notLoggedIn.failure.message).toContain('10x-chat login chatgpt');
      }

      providerSpy.mockReturnValueOnce({
        actions: {
          isLoggedIn: async () => {
            throw new Error('challenge visible');
          },
        },
      } as never);
      const backend7 = createChatgptUseBackend({
        runner: fakeRunner([
          {
            code: 0,
            stdout: JSON.stringify({
              status: 'completed',
              request_id: 'req-1',
              conversation_id: 'conv-1',
              result: { text: 'ok' },
            }),
            stderr: '',
            timedOut: false,
          },
        ]).runner,
        projectsPath,
      });
      const loginCheckFailed = await backend7.ask({ ...request, chatgptProject: 'chatgpt-use' });
      expect(loginCheckFailed.ok).toBe(false);
      if (!loginCheckFailed.ok) {
        expect(loginCheckFailed.failure.kind).toBe('unavailable');
        expect(loginCheckFailed.failure.submission).toBe('submitted');
        expect(loginCheckFailed.failure.message).toContain('challenge visible');
      }
    } finally {
      launchSpy.mockRestore();
      providerSpy.mockRestore();
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
      expect(closeCount).toBeGreaterThan(0);
    }
  });

  it('declares serial ChatGPT capacity at the backend boundary', () => {
    const backend = createChatgptUseBackend();
    expect(backend.capabilities.maxConcurrentRequests).toBe(1);
  });

  it('serializes concurrent callers and reports active slot diagnostics', async () => {
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        const id = args[args.indexOf('--request-id') + 1] ?? 'req-1';
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (id === 'req-1') await held;
        active -= 1;
        return { code: 0, stdout: completed('ok', id), stderr: '', timedOut: false };
      },
    };
    const backend = createChatgptUseBackend({ runner });

    const first = backend.ask(request);
    const second = backend.ask({ ...request, requestId: 'req-2' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();
    const [one, two] = await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(one.ok && one.value.queueWaitMs).toBe(0);
    expect(one.ok && one.value.activeSlots).toBe(1);
    expect(two.ok && (two.value.queueWaitMs ?? -1)).toBeGreaterThanOrEqual(0);
    expect(two.ok && two.value.activeSlots).toBe(1);
  });

  it('cancels a queued request before it starts without submitting it', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        calls.push(args);
        const id = args[args.indexOf('--request-id') + 1] ?? 'req-1';
        if (id === 'req-1') await held;
        return { code: 0, stdout: completed('ok', id), stderr: '', timedOut: false };
      },
    };
    const backend = createChatgptUseBackend({ runner });
    const controller = new AbortController();

    const first = backend.ask(request);
    const second = backend.ask({ ...request, requestId: 'req-2', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    release?.();

    const [one, two] = await Promise.all([first, second]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(false);
    if (two.ok) return;
    expect(two.failure.kind).toBe('cancelled');
    expect(two.failure.submission).toBe('not_submitted');
    expect(calls.some((args) => args.includes('req-2') && args[0] === 'ask')).toBe(false);
  });

  it('requests backend cancellation for an active aborted request and does not retry unknown submission', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        calls.push(args);
        const id = args[args.indexOf('--request-id') + 1] ?? 'req-1';
        if (args[0] === 'cancel') {
          return {
            code: 0,
            stdout: JSON.stringify({ status: 'cancelled', request_id: id }),
            stderr: '',
            timedOut: false,
          };
        }
        await held;
        return {
          code: 7,
          stdout: failed('busy', 'yes', 'cancelled by user'),
          stderr: '',
          timedOut: false,
        };
      },
    };
    const backend = createChatgptUseBackend({ runner });
    const controller = new AbortController();

    const pending = backend.ask({ ...request, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    release?.();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('cancelled');
    expect(outcome.failure.submission).toBe('submitted');
    expect(calls.filter((args) => args[0] === 'ask')).toHaveLength(1);
    expect(calls.some((args) => args[0] === 'cancel' && args.includes('req-1'))).toBe(true);
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
