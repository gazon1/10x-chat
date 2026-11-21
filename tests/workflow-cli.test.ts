import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resumeBackendOf, startOptionsOf } from '../src/cli/workflow.js';
import { listWorkflows, loadWorkflow, saveWorkflow } from '../src/workflow/store.js';
import type { WorkflowRecord } from '../src/workflow/types.js';
import { runCli } from './e2e/helpers.js';

const exec = promisify(execFile);

/**
 * The tests of the command of the workflow.
 *
 * The command drives the real CLI: the Orca, the git and the review are not
 * reached here — the workflow of an Issue needs all of them, and the loop
 * itself is covered by the unit tests of the workflow.
 */

/** A record of a workflow — the state of a run that has ended. */
function aRecord(id: string): WorkflowRecord {
  return {
    version: 1,
    id,
    state: 'completed',
    repository: 'gazon1/10x-chat',
    issue: {
      number: 59,
      url: 'https://github.com/gazon1/10x-chat/issues/59',
      title: 'The issue of the workflow',
      body: 'The body of the issue.',
      hash: 'hash-of-the-issue',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    worktree: {
      id: 'wt-1',
      path: '/wt/issue-59',
      branch: '10x-chat/issue-59',
      baseRef: 'main',
      baseSha: 'base-sha',
    },
    agent: 'codex',
    backend: 'chatgpt-use',
    maxIterations: 3,
    iterations: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('the command of the workflow (CLI)', () => {
  it('offers the steps of the workflow', async () => {
    const res = await runCli(['workflow', '--help']);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('start');
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('resume');
    expect(res.stdout).toContain('stop');
    expect(res.stdout).toContain('report');
  });

  it('reports a workflow that is not there', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));

    const res = await runCli(['workflow', 'status', 'issue-59-nothing'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(res.code).toBe(1);
    expect(res.output).toContain('Workflow not found');
  });

  it('shows the state and the report of a workflow', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const original = process.env.TEN_X_CHAT_HOME;
    process.env.TEN_X_CHAT_HOME = home;
    try {
      await saveWorkflow(aRecord('issue-59-20260101000000-abcd1234'));
    } finally {
      if (original === undefined) delete process.env.TEN_X_CHAT_HOME;
      else process.env.TEN_X_CHAT_HOME = original;
    }

    const status = await runCli(['workflow', 'status', 'issue-59-20260101000000-abcd1234'], {
      TEN_X_CHAT_HOME: home,
    });
    const report = await runCli(['workflow', 'report', 'issue-59-20260101000000-abcd1234'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(status.code).toBe(0);
    expect(status.stdout).toContain('issue-59-20260101000000-abcd1234: completed');
    expect(status.stdout).toContain('The issue of the workflow');
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('# Development workflow — issue #59');
    expect(report.stdout).toContain('/wt/issue-59');
  });

  it('refuses an Issue that is not a number', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));

    const res = await runCli(['workflow', 'start', '--issue', 'fifty-nine'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(res.code).toBe(1);
    expect(res.output).toContain('Invalid --issue value');
  });

  it('stops a workflow that waits for its agent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const original = process.env.TEN_X_CHAT_HOME;
    process.env.TEN_X_CHAT_HOME = home;
    try {
      const record = aRecord('issue-59-20260101000000-abcd1234');
      await saveWorkflow({ ...record, state: 'implementation-running' });

      const res = await runCli(['workflow', 'stop', 'issue-59-20260101000000-abcd1234'], {
        TEN_X_CHAT_HOME: home,
      });

      expect(res.code).toBe(0);
      expect(res.stdout).toContain('issue-59-20260101000000-abcd1234: cancelled');
      // The state of the workflow is written down.
      const stored = await loadWorkflow('issue-59-20260101000000-abcd1234');
      expect(stored.state).toBe('cancelled');
    } finally {
      if (original === undefined) delete process.env.TEN_X_CHAT_HOME;
      else process.env.TEN_X_CHAT_HOME = original;
    }
  });

  it('reports that a workflow cannot be continued', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));

    const res = await runCli(['workflow', 'resume', 'issue-59-nothing'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(res.code).toBe(1);
    expect(res.output).toContain('Workflow not found');
  });

  it('refuses to start a workflow of a checkout that is not a repository', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-cwd-'));

    const res = await runCli(
      ['workflow', 'start', '--issue', '59'],
      {
        TEN_X_CHAT_HOME: home,
      },
      undefined,
      { cwd },
    );

    expect(res.code).toBe(1);
    expect(res.output).toContain('no origin remote');
  });

  it('resumes a workflow with the backend and the model it was started with', () => {
    // The backend of the record is the backend of the review — the next
    // iteration is judged by the same one.
    expect(resumeBackendOf({ backendName: 'chatgpt-use', model: 'gpt-5' }, {})).toEqual({
      backend: 'chatgpt-use',
      model: 'gpt-5',
    });
    // The command line wins: the user may change the model on purpose.
    expect(
      resumeBackendOf({ backendName: 'chatgpt-use' }, { backend: 'chrome-use-perplexity' }),
    ).toEqual({ backend: 'chrome-use-perplexity' });
    expect(resumeBackendOf({ backendName: 'chatgpt-use' }, { model: 'gpt-4' })).toEqual({
      backend: 'chatgpt-use',
      model: 'gpt-4',
    });
    // A backend that is not there is a refusal and not a silent fallback.
    expect(() => resumeBackendOf({ backendName: 'not-a-backend' }, {})).toThrow(/not available/);
  });

  it('translates the options of the command line into the options of the workflow', () => {
    expect(
      startOptionsOf({
        issue: 59,
        agent: 'claude',
        backend: 'chatgpt-use',
        model: 'gpt-5',
        maxIterations: 5,
        base: 'main',
        wait: 30_000,
      }),
    ).toEqual({
      issue: 59,
      agent: 'claude',
      backendName: 'chatgpt-use',
      model: 'gpt-5',
      maxIterations: 5,
      baseRef: 'main',
      waitTimeoutMs: 30_000,
    });
    // What is not named stays unnamed — the workflow has its own defaults.
    expect(startOptionsOf({ issue: 59, backend: 'chatgpt-use' })).toEqual({
      issue: 59,
      backendName: 'chatgpt-use',
    });
  });

  it('continues a workflow that has ended', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const original = process.env.TEN_X_CHAT_HOME;
    process.env.TEN_X_CHAT_HOME = home;
    try {
      await saveWorkflow(aRecord('issue-59-20260101000000-abcd1234'));
    } finally {
      if (original === undefined) delete process.env.TEN_X_CHAT_HOME;
      else process.env.TEN_X_CHAT_HOME = original;
    }

    const res = await runCli(['workflow', 'resume', 'issue-59-20260101000000-abcd1234'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('issue-59-20260101000000-abcd1234: completed');
  });

  it('refuses to continue a workflow whose backend is not there', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const original = process.env.TEN_X_CHAT_HOME;
    process.env.TEN_X_CHAT_HOME = home;
    try {
      await saveWorkflow({
        ...aRecord('issue-59-20260101000000-abcd1234'),
        backendName: 'not-a-backend',
      });
    } finally {
      if (original === undefined) delete process.env.TEN_X_CHAT_HOME;
      else process.env.TEN_X_CHAT_HOME = original;
    }

    const res = await runCli(['workflow', 'resume', 'issue-59-20260101000000-abcd1234'], {
      TEN_X_CHAT_HOME: home,
    });

    expect(res.code).toBe(1);
    expect(res.output).toContain('not available');
  });

  it('starts the workflow of an Issue through the command line', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-cli-'));
    const bin = path.join(home, 'bin');
    const checkout = path.join(home, 'checkout');
    const worktree = path.join(home, 'worktree');
    await mkdir(bin, { recursive: true });
    await mkdir(checkout, { recursive: true });

    // A checkout of the repository with the worktree of the branch of the
    // Issue: the workflow checks the identity of the worktree that Orca
    // reports, and a worktree of another repository is refused.
    await exec('git', ['init', '-b', 'main', checkout]);
    await exec('git', ['-C', checkout, 'commit', '--allow-empty', '-m', 'the first commit'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    await exec('git', [
      '-C',
      checkout,
      'remote',
      'add',
      'origin',
      'https://github.com/gazon1/10x-chat.git',
    ]);
    await exec('git', [
      '-C',
      checkout,
      'worktree',
      'add',
      '-b',
      '10x-chat/issue-59',
      worktree,
      'main',
    ]);

    // The Orca of the test — it answers like the CLI of Orca does.
    await writeFile(
      path.join(bin, 'orca'),
      `#!/bin/sh
case "$1 $2" in
"status "*) printf '%s\\n' '{"ok":true,"result":{"runtime":{"state":"ready","reachable":true,"capabilities":["orchestration.contract.v1","worktree.create"]},"graph":{"state":"ready"}}}' ;;
"repo list") printf '%s\\n' '{"ok":true,"result":{"repos":[{"id":"repo-1","path":"${checkout}","gitRemoteIdentity":{"canonicalKey":"github.com/gazon1/10x-chat"}}]}}' ;;
"worktree list") printf '%s\\n' '{"ok":true,"result":{"worktrees":[]}}' ;;
"worktree create") printf '%s\\n' '{"ok":true,"result":{"worktree":{"id":"wt-1","path":"${worktree}","branch":"10x-chat/issue-59"}}}' ;;
"orchestration run-create") printf '%s\\n' '{"ok":true,"result":{"runId":"run-1"}}' ;;
"orchestration worker-start") printf '%s\\n' '{"ok":true,"result":{"dispatchId":"dispatch-1","taskId":"task-1","state":"working"}}' ;;
"orchestration worker-list") printf '%s\\n' '{"ok":true,"result":{"workers":[]}}' ;;
"orchestration worker-show") printf '%s\\n' '{"ok":true,"result":{"dispatchId":"dispatch-1","state":"working"}}' ;;
"orchestration check") printf '%s\\n' '{"ok":true,"result":{"messages":[]}}' ;;
*) printf '%s\\n' '{"ok":true,"result":{}}' ;;
esac
`,
      'utf-8',
    );
    await chmod(path.join(bin, 'orca'), 0o755);

    // The `gh` CLI of the test — it answers with the Issue of the workflow.
    const issueFile = path.join(home, 'issue.json');
    await writeFile(
      issueFile,
      JSON.stringify({
        number: 59,
        url: 'https://github.com/gazon1/10x-chat/issues/59',
        title: 'The issue of the workflow',
        body: 'The body of the issue.',
      }),
      'utf-8',
    );
    await writeFile(
      path.join(bin, 'gh'),
      `#!/bin/sh
case "$1 $2" in
"auth status") exit 0;;
"issue view") cat "${issueFile}";;
esac
`,
      'utf-8',
    );
    await chmod(path.join(bin, 'gh'), 0o755);

    const res = await runCli(
      ['workflow', 'start', '--issue', '59', '--base', 'main', '--wait', '200'],
      { TEN_X_CHAT_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
      undefined,
      { cwd: checkout },
    );

    expect(res.code).toBe(0);
    // The workflow read the Issue, created the worktree and started the agent.
    expect(res.stdout).toContain(': implementation-running');
    const original = process.env.TEN_X_CHAT_HOME;
    process.env.TEN_X_CHAT_HOME = home;
    try {
      const [id] = await listWorkflows();
      const stored = await loadWorkflow(id);
      expect(stored.worktree?.branch).toBe('10x-chat/issue-59');
      expect(stored.worktree?.path).toBe(worktree);
      expect(stored.orca?.dispatchId).toBe('dispatch-1');
    } finally {
      if (original === undefined) delete process.env.TEN_X_CHAT_HOME;
      else process.env.TEN_X_CHAT_HOME = original;
    }
  });
});
