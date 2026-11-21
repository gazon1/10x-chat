import { describe, expect, it } from 'vitest';
import type { ProcessResult, ProcessRunner } from '../src/backend/process-runner.js';
import { OrcaClient, OrcaError } from '../src/orca/client.js';

/**
 * The tests of the adapter of the Orca CLI.
 *
 * The CLI is another program: its answer is data, and the adapter checks it
 * before it uses it. The runner is the seam — no Orca, no runtime, no network.
 */

interface Call {
  command: string;
  args: string[];
}

/** A runner that answers with the envelopes, one after the other. */
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

/** The answer of a command that succeeded. */
function ok(result: unknown): ProcessResult {
  return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '', timedOut: false };
}

describe('the adapter of the Orca CLI', () => {
  it('reads the readiness and the capabilities of the runtime', async () => {
    const { runner } = fakeRunner([
      ok({
        runtime: { state: 'ready', reachable: true, capabilities: ['orchestration.contract.v1'] },
        graph: { state: 'ready' },
      }),
    ]);
    const client = new OrcaClient({ runner });

    const status = await client.status();

    expect(status.ready).toBe(true);
    expect(status.capabilities).toEqual(['orchestration.contract.v1']);
  });

  it('reports a runtime that is not ready', async () => {
    const { runner } = fakeRunner([
      ok({
        runtime: { state: 'starting', reachable: true, capabilities: [] },
        graph: { state: 'ready' },
      }),
    ]);
    const client = new OrcaClient({ runner });

    const status = await client.status();

    expect(status.ready).toBe(false);
    expect(status.detail).toContain('starting');
  });

  it('refuses an answer that is not JSON', async () => {
    const { runner } = fakeRunner([
      { code: 0, stdout: 'not json at all', stderr: '', timedOut: false },
    ]);
    const client = new OrcaClient({ runner });

    await expect(client.status()).rejects.toThrow(OrcaError);
  });

  it('refuses an answer that reports a failure', async () => {
    const { runner } = fakeRunner([
      {
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { message: 'the repo is unknown' } }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const client = new OrcaClient({ runner });

    await expect(client.repoList()).rejects.toThrow('the repo is unknown');
  });

  it('reads the repositories of the runtime', async () => {
    const { runner } = fakeRunner([
      ok({
        repos: [
          {
            id: 'repo-1',
            path: '/repo',
            displayName: '10x-chat',
            gitRemoteIdentity: { canonicalKey: 'github.com/gazon1/10x-chat' },
          },
        ],
      }),
    ]);
    const client = new OrcaClient({ runner });

    const repos = await client.repoList();

    expect(repos).toHaveLength(1);
    expect(repos[0]?.id).toBe('repo-1');
    expect(repos[0]?.canonicalKey).toBe('github.com/gazon1/10x-chat');
  });

  it('reads the workers of a run, whatever the shape of the answer is', async () => {
    const { runner } = fakeRunner([
      ok({ workers: [{ dispatchId: 'dispatch-1', taskId: 'task-1', state: 'working' }] }),
    ]);
    const client = new OrcaClient({ runner });

    const workers = await client.workerList('run-1');

    expect(workers).toHaveLength(1);
    expect(workers[0]?.dispatchId).toBe('dispatch-1');
    expect(workers[0]?.state).toBe('working');
  });

  it('refuses a worker that has no dispatch id', async () => {
    const { runner } = fakeRunner([ok({ taskId: 'task-1' })]);
    const client = new OrcaClient({ runner });

    await expect(
      client.workerStart({
        runId: 'run-1',
        spec: 'the spec',
        worktree: 'path:/wt',
        agent: 'codex',
        taskTitle: 'the task',
      }),
    ).rejects.toThrow('without a dispatch id');
  });

  it('passes the body of a message as an argument, never as a shell', async () => {
    const { runner, calls } = fakeRunner([ok({ accepted: true })]);
    const client = new OrcaClient({ runner });

    await client.send({
      to: 'dispatch:dispatch-1',
      subject: 'the findings',
      body: 'a body with "quotes" and $(rm -rf /)',
    });

    const call = calls[0];
    expect(call?.command).toBe('orca');
    expect(call?.args).toContain('--to');
    expect(call?.args).toContain('dispatch:dispatch-1');
    expect(call?.args).toContain('a body with "quotes" and $(rm -rf /)');
  });

  it('reads the messages of the mailbox of a run', async () => {
    const { runner } = fakeRunner([
      ok({
        messages: [
          { type: 'worker_done', dispatchId: 'dispatch-1', outcome: 'succeeded', result: 'done' },
        ],
      }),
    ]);
    const client = new OrcaClient({ runner });

    const messages = await client.check('run-1', { timeoutMs: 1000, types: ['worker_done'] });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe('worker_done');
    expect(messages[0]?.outcome).toBe('succeeded');
    expect(messages[0]?.text).toBe('done');
  });

  it('refuses a command that failed, whatever its answer says', async () => {
    const { runner } = fakeRunner([
      {
        code: 2,
        stdout: JSON.stringify({ ok: true, result: { worktrees: [] } }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const client = new OrcaClient({ runner });

    await expect(client.worktreeList('repo-1')).rejects.toThrow('failed');
  });

  it('reads the worktrees of a repository', async () => {
    const { runner, calls } = fakeRunner([
      ok({
        worktrees: [
          {
            id: 'wt-1',
            path: '/wt/issue-59',
            displayName: 'issue-59',
            branch: 'refs/heads/10x-chat/issue-59',
            head: 'abc123',
            comment: 'the checkpoint of the workflow',
            isMainWorktree: false,
          },
        ],
      }),
    ]);
    const client = new OrcaClient({ runner });

    const worktrees = await client.worktreeList('repo-1');

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.id).toBe('wt-1');
    expect(worktrees[0]?.name).toBe('issue-59');
    expect(worktrees[0]?.branch).toBe('refs/heads/10x-chat/issue-59');
    // The comment is the checkpoint of the workflow — it is read before it is
    // written, and the main worktree is never taken over.
    expect(worktrees[0]?.comment).toBe('the checkpoint of the workflow');
    expect(worktrees[0]?.isMainWorktree).toBe(false);
    expect(calls[0]?.args).toContain('id:repo-1');
  });

  it('reads the structured outcome of a worker', async () => {
    const { runner } = fakeRunner([
      ok({
        dispatchId: 'dispatch-1',
        state: 'settled',
        outcome: 'succeeded',
        report: 'the change is done',
      }),
    ]);
    const client = new OrcaClient({ runner });

    const worker = await client.workerShow('dispatch-1');

    // The outcome is a field of its own: it is not the state of the Dispatch.
    expect(worker.state).toBe('settled');
    expect(worker.outcome).toBe('succeeded');
    expect(worker.report).toBe('the change is done');
  });
});
