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

  it('refuses to read a list of repositories that the answer does not hold', async () => {
    const { runner } = fakeRunner([ok({ nothing: true })]);
    const client = new OrcaClient({ runner });

    // An unknown list is not an empty list: a repository that cannot be seen
    // may be there, and the workflow would refuse the wrong one.
    await expect(client.repoList()).rejects.toThrow(/without the repositories/);
  });

  it('refuses a repository that the answer does not name', async () => {
    const { runner } = fakeRunner([ok({ repos: [{ id: 'repo-1' }] })]);
    const client = new OrcaClient({ runner });

    // A repository without a path is not a repository that can be ignored:
    // the workflow cannot tell which checkout it works in.
    await expect(client.repoList()).rejects.toThrow(/without an id or a path/);
  });

  it('refuses a worktree that the answer does not name', async () => {
    const { runner } = fakeRunner([
      ok({ worktrees: [{ id: 'wt-1', path: '/wt/issue-59' }, { branch: '10x-chat/issue-59' }] }),
    ]);
    const client = new OrcaClient({ runner });

    // A worktree that cannot be named is not a worktree that can be ignored:
    // the workflow would create a second one for the same Issue.
    await expect(client.worktreeList('repo-1')).rejects.toThrow(/without an id or a path/);
  });

  it('reads the field of the name that the caller asks for first', async () => {
    // The order of the keys of the answer is not the priority of the caller:
    // the report of the worker is the field 'report', and the summary beside
    // it does not hide it.
    const { runner } = fakeRunner([ok({ summary: 'the summary', report: 'the report' })]);
    const client = new OrcaClient({ runner });

    const worker = await client.workerShow('dispatch-1');

    expect(worker.report).toBe('the report');
  });

  it('refuses to read a list of workers that the answer does not hold', async () => {
    const { runner } = fakeRunner([ok({ nothing: true })]);
    const client = new OrcaClient({ runner });

    // An unknown list is not an empty list: a worker that cannot be seen may
    // be there, and a second agent would work in the same worktree.
    await expect(client.workerList('run-1')).rejects.toThrow(/without the workers/);
  });

  it('refuses to read a list of worktrees that the answer does not hold', async () => {
    const { runner } = fakeRunner([ok({ nothing: true })]);
    const client = new OrcaClient({ runner });

    // An unknown list is not an empty list: a worktree that cannot be seen may
    // be there, and a second worktree of the Issue is a second change.
    await expect(client.worktreeList('repo-1')).rejects.toThrow(/without the worktrees/);
  });

  it('reads an empty list of workers when the answer holds one', async () => {
    const { runner } = fakeRunner([ok({ workers: [] })]);
    const client = new OrcaClient({ runner });

    expect(await client.workerList('run-1')).toEqual([]);
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

  it('reads the identity of the workers of a run', async () => {
    const { runner } = fakeRunner([
      ok({
        workers: [
          {
            dispatchId: 'dispatch-1',
            taskId: 'task-1',
            state: 'working',
            branch: '10x-chat/issue-59',
            taskTitle: 'Issue #59: the corrections of the iteration 1',
            // The worktree is a nested object of the answer of the runtime.
            worktree: { path: '/wt/issue-59' },
          },
        ],
      }),
    ]);
    const client = new OrcaClient({ runner });

    const workers = await client.workerList('run-1');

    // The identity of a worker is in the answer: the checkout it works in, the
    // branch and the task it was given.
    expect(workers[0]?.worktreePath).toBe('/wt/issue-59');
    expect(workers[0]?.branch).toBe('10x-chat/issue-59');
    expect(workers[0]?.taskTitle).toBe('Issue #59: the corrections of the iteration 1');
  });

  it('reads the identity of a worker', async () => {
    const { runner } = fakeRunner([
      ok({
        dispatchId: 'dispatch-1',
        state: 'working',
        worktreePath: '/wt/issue-59',
        branch: '10x-chat/issue-59',
        taskTitle: 'Issue #59: the corrections of the iteration 1',
      }),
    ]);
    const client = new OrcaClient({ runner });

    const worker = await client.workerShow('dispatch-1');

    expect(worker.worktreePath).toBe('/wt/issue-59');
    expect(worker.branch).toBe('10x-chat/issue-59');
    expect(worker.taskTitle).toBe('Issue #59: the corrections of the iteration 1');
  });

  it('keeps the title of the task of a worker that the runtime does not name', async () => {
    const { runner } = fakeRunner([ok({ dispatchId: 'dispatch-1', state: 'working' })]);
    const client = new OrcaClient({ runner });

    const worker = await client.workerStart({
      runId: 'run-1',
      spec: 'the spec',
      worktree: 'path:/wt',
      agent: 'codex',
      taskTitle: 'Issue #59: the corrections of the iteration 1',
    });

    // The runtime does not have to name the task again: the workflow knows
    // which task a worker works on.
    expect(worker.taskTitle).toBe('Issue #59: the corrections of the iteration 1');
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

  it('creates a worktree with the arguments of the CLI', async () => {
    const { runner, calls } = fakeRunner([
      ok({
        worktree: {
          id: 'wt-1',
          path: '/wt/issue-59',
          branch: 'refs/heads/10x-chat/issue-59',
          head: 'abc123',
          comment: '10x-chat workflow issue-59-1: created',
          linkedIssue: 59,
        },
      }),
    ]);
    const client = new OrcaClient({ runner });

    const worktree = await client.worktreeCreate({
      repoId: 'repo-1',
      name: 'issue-59',
      branch: '10x-chat/issue-59',
      baseRef: 'main',
      issue: 59,
      comment: '10x-chat workflow issue-59-1: created',
    });

    expect(worktree.id).toBe('wt-1');
    expect(worktree.path).toBe('/wt/issue-59');
    expect(worktree.branch).toBe('refs/heads/10x-chat/issue-59');
    expect(worktree.head).toBe('abc123');
    // The owner of the worktree is written at once — the worktree of a lost
    // answer carries the proof that it is ours.
    expect(worktree.comment).toBe('10x-chat workflow issue-59-1: created');
    expect(worktree.linkedIssue).toBe(59);
    const args = calls[0]?.args ?? [];
    expect(args).toContain('worktree');
    expect(args).toContain('create');
    expect(args).toContain('--repo');
    expect(args).toContain('id:repo-1');
    expect(args).toContain('--name');
    expect(args).toContain('issue-59');
    expect(args).toContain('--branch');
    expect(args).toContain('10x-chat/issue-59');
    expect(args).toContain('--base-branch');
    expect(args).toContain('main');
    expect(args).toContain('--issue');
    expect(args).toContain('59');
    expect(args).toContain('--comment');
    expect(args).toContain('10x-chat workflow issue-59-1: created');
  });

  it('refuses a worktree that has no path', async () => {
    const { runner } = fakeRunner([ok({ worktree: { id: 'wt-1' } })]);
    const client = new OrcaClient({ runner });

    await expect(
      client.worktreeCreate({
        repoId: 'repo-1',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        baseRef: 'main',
        issue: 59,
        comment: '10x-chat workflow issue-59-1: created',
      }),
    ).rejects.toThrow('without the worktree it created');
  });

  it('creates a run and reads its id', async () => {
    const { runner, calls } = fakeRunner([ok({ runId: 'run-1' })]);
    const client = new OrcaClient({ runner });

    const runId = await client.runCreate('the objective of the run');

    expect(runId).toBe('run-1');
    const args = calls[0]?.args ?? [];
    expect(args).toContain('orchestration');
    expect(args).toContain('run-create');
    expect(args).toContain('--objective');
    expect(args).toContain('the objective of the run');
  });

  it('refuses a run without an id', async () => {
    const { runner } = fakeRunner([ok({ created: true })]);
    const client = new OrcaClient({ runner });

    await expect(client.runCreate('the objective of the run')).rejects.toThrow('without a run id');
  });

  it('reads the runs of the orchestration, whatever the shape of the answer is', async () => {
    const { runner, calls } = fakeRunner([
      ok({ runs: [{ id: 'run-1', objective: 'the objective of the run' }, { title: 'no id' }] }),
    ]);
    const client = new OrcaClient({ runner });

    const runs = await client.runList();

    // The run without an id is not a run.
    expect(runs).toEqual([{ id: 'run-1', objective: 'the objective of the run' }]);
    const args = calls[0]?.args ?? [];
    expect(args).toContain('orchestration');
    expect(args).toContain('run-list');
  });

  it('refuses to read a list of runs that the answer does not hold', async () => {
    const { runner } = fakeRunner([ok({ nothing: true })]);
    const client = new OrcaClient({ runner });

    // An unknown list is not an empty list: a Run that cannot be seen cannot
    // be adopted, and a second Run of the same objective would be a second
    // mailbox.
    await expect(client.runList()).rejects.toThrow(/without the runs/);
  });

  it('reads an empty list of runs when the answer holds one', async () => {
    const { runner } = fakeRunner([ok({ runs: [] })]);
    const client = new OrcaClient({ runner });

    expect(await client.runList()).toEqual([]);
  });

  it('stops a worker by its dispatch', async () => {
    const { runner, calls } = fakeRunner([ok({ stopped: true })]);
    const client = new OrcaClient({ runner });

    await client.workerStop('dispatch-1');

    const args = calls[0]?.args ?? [];
    expect(args).toContain('orchestration');
    expect(args).toContain('worker-stop');
    expect(args).toContain('--dispatch');
    expect(args).toContain('dispatch-1');
  });

  it('refuses to stop a worker that the CLI could not stop', async () => {
    const { runner } = fakeRunner([
      { code: 1, stdout: '', stderr: 'the dispatch is gone', timedOut: false },
    ]);
    const client = new OrcaClient({ runner });

    await expect(client.workerStop('dispatch-1')).rejects.toThrow('the dispatch is gone');
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
            linkedIssue: 59,
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
    // The Issue of the worktree is the proof that it belongs to the Issue.
    expect(worktrees[0]?.linkedIssue).toBe(59);
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
