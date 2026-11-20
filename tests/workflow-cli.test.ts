import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveWorkflow } from '../src/workflow/store.js';
import type { WorkflowRecord } from '../src/workflow/types.js';
import { runCli } from './e2e/helpers.js';

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
});
