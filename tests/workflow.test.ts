import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBackend } from '../src/backend/fake.js';
import type {
  OrcaApi,
  OrcaMessage,
  OrcaRepo,
  OrcaWorker,
  OrcaWorktree,
} from '../src/orca/client.js';
import { getWorkflowDir } from '../src/paths.js';
import type {
  Finding,
  IssueRequirements,
  ReviewRun,
  ReviewVerdict,
  StepOutcome,
} from '../src/pipeline/types.js';
import type { WorkflowGit } from '../src/workflow/git.js';
import {
  createWorkflowContext,
  resumeWorkflow,
  startWorkflow,
  stopWorkflow,
  type WorkflowContext,
  type WorkflowReviewRequest,
} from '../src/workflow/orchestrator.js';
import { listWorkflows, loadWorkflow, readEvents, saveWorkflow } from '../src/workflow/store.js';
import { assertTransition, canTransition, isTerminal } from '../src/workflow/transitions.js';
import type { WorkflowRecord } from '../src/workflow/types.js';

/**
 * The tests of the development workflow.
 *
 * Nothing here touches Orca, GitHub or a model: the Orca adapter, the git of
 * the checkout and the review of the change are the seams of the workflow, and
 * every test replaces them with a fake that answers the way the real one does.
 */

/** The Orca of the tests — it records what the workflow asked of it. */
class FakeOrca implements OrcaApi {
  readonly started: { spec: string; worktree: string }[] = [];
  readonly sent: { to: string; subject: string; body: string }[] = [];
  readonly stopped: string[] = [];
  readonly runs: string[] = [];
  /** The worktrees the workflow created — a second one is a defect. */
  readonly created: { name: string; branch: string; baseRef: string }[] = [];
  /** The workers of the Run — the workflow must not start a second one. */
  workers: OrcaWorker[] = [];
  /** The worktrees of the repository — a lost answer is reconciled with them. */
  worktrees: OrcaWorktree[] = [];
  /** The messages the mailbox answers with. */
  messages: OrcaMessage[] = [
    { type: 'worker_done', outcome: 'succeeded', text: 'the work is done' },
  ];
  /** The state the worker reports. */
  workerState = 'working';
  ready = true;
  capabilities = ['orchestration.contract.v1', 'worktree.create'];
  repos: OrcaRepo[] = [
    {
      id: 'repo-1',
      path: '/repo',
      displayName: '10x-chat',
      canonicalKey: 'github.com/gazon1/10x-chat',
    },
  ];
  /** What the mailbox does when it is asked — the agent commits there. */
  onCheck?: () => void;
  /** What the runtime answers when the worker is stopped. */
  stopError?: Error;

  /** What the mailbox answers when the findings do not arrive. */
  sendError?: Error;

  async status() {
    return { ready: this.ready, capabilities: this.capabilities };
  }

  async repoList() {
    return this.repos;
  }

  async worktreeCreate(options: { name: string; branch: string; baseRef: string }) {
    this.created.push(options);
    const worktree = {
      id: 'wt-1',
      path: '/wt/issue-59',
      name: options.name,
      branch: options.branch,
    };
    this.worktrees.push(worktree);
    return worktree;
  }

  async worktreeList() {
    return this.worktrees;
  }

  async worktreeComment() {}

  async runCreate(objective: string) {
    this.runs.push(objective);
    return 'run-1';
  }

  async workerStart(options: { spec: string; worktree: string }) {
    this.started.push({ spec: options.spec, worktree: options.worktree });
    const worker = { dispatchId: 'dispatch-1', taskId: 'task-1', state: 'working' };
    // The runtime knows the worker — a workflow that starts a second one is
    // visible to the next run.
    this.workers.push(worker);
    return worker;
  }

  async workerShow(dispatchId: string) {
    return { dispatchId, state: this.workerState };
  }

  async workerList() {
    return this.workers;
  }

  async workerStop(dispatchId: string) {
    if (this.stopError) throw this.stopError;
    this.stopped.push(dispatchId);
    this.workerState = 'stopped';
  }

  async send(options: { to: string; subject: string; body: string }) {
    if (this.sendError) throw this.sendError;
    this.sent.push(options);
  }

  async check() {
    this.onCheck?.();
    return this.messages;
  }
}

/** The git of the tests — the head of the worktree is a variable. */
class FakeGit implements WorkflowGit {
  head = 'base-sha';
  /** The repository of the checkout — an empty name is a broken checkout. */
  repositoryName = 'gazon1/10x-chat';

  async repository() {
    return this.repositoryName;
  }

  async revParse() {
    return this.head;
  }

  async defaultBaseRef() {
    return 'main';
  }
}

/** A finding of the review — the shape the pipeline produces. */
function aFinding(id = 'F-1'): Finding {
  return {
    id,
    title: 'The check does not run',
    severity: 'BLOCKING',
    category: 'correctness',
    file: 'src/workflow/orchestrator.ts',
    line: 42,
    problem: 'The check of the change is never run.',
    impact: 'A broken change is merged.',
    evidence: ['the test of the check does not exist'],
    fix: 'Run the check before the commit.',
    verification: 'confirmed',
    reportedBy: ['correctness'],
  };
}

/** What a review answers with. */
interface Verdict {
  verdict: ReviewVerdict;
  reason: string;
  steps?: StepOutcome[];
  findings?: Finding[];
}

const PASSED_STEPS: StepOutcome[] = [
  { id: 'collect-context', status: 'passed' },
  { id: 'build-bundle', status: 'passed' },
  { id: 'review-correctness', status: 'passed' },
  { id: 'verify-findings', status: 'passed' },
  { id: 'check-requirements', status: 'passed' },
  { id: 'update-requirements', status: 'passed' },
];

/** A review that answers with the verdicts, one after the other. */
function fakeReview(git: FakeGit, verdicts: Verdict[]) {
  const seen: WorkflowReviewRequest[] = [];
  const review = async (request: WorkflowReviewRequest): Promise<ReviewRun> => {
    seen.push(request);
    const next = verdicts.shift() ?? { verdict: 'APPROVE' as ReviewVerdict, reason: 'clean' };
    return {
      id: request.runId,
      target: { cwd: request.cwd, base: request.base, issue: request.issue, local: true },
      context: {
        repoRoot: request.cwd,
        repository: 'gazon1/10x-chat',
        baseRef: request.base,
        baseSha: 'base-sha',
        headRef: 'HEAD',
        headSha: git.head,
        changedFiles: ['src/workflow/orchestrator.ts'],
        trackedFiles: ['src/workflow/orchestrator.ts'],
        deletedFiles: [],
        secretFiles: [],
        diff: 'diff --git a/src/workflow/orchestrator.ts b/src/workflow/orchestrator.ts',
        diffTruncated: false,
        local: true,
      },
      steps: next.steps ?? PASSED_STEPS,
      findings: next.findings ?? [],
      decisions: [],
      verdict: next.verdict,
      verdictReason: next.reason,
      report: '# The report of the review',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
    };
  };
  return { review, seen };
}

describe('the development workflow', () => {
  const originalEnv = process.env;
  let home = '';

  beforeEach(async () => {
    process.env = { ...originalEnv };
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /** The context of a test — the clock moves on every call. */
  function contextOf(
    orca: FakeOrca,
    git: FakeGit,
    options: {
      review?: (request: WorkflowReviewRequest) => Promise<ReviewRun>;
      requirements?: (issue: number, repository: string) => Promise<IssueRequirements>;
      assertAuthenticated?: () => Promise<void>;
      waitTimeoutMs?: number;
    } = {},
  ): WorkflowContext {
    let tick = 0;
    return createWorkflowContext({
      orca,
      cwd: '/repo',
      git,
      backend: createFakeBackend(),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)),
      waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
      ...(options.review ? { review: options.review } : {}),
      readRequirements: async (issue, repository) => ({
        repository,
        number: issue,
        url: `https://github.com/${repository}/issues/${issue}`,
        title: 'The issue of the workflow',
        body: 'The body of the issue.',
        hash: 'hash-of-the-issue',
        status: 'initial',
        observedAt: '2026-01-01T00:00:00.000Z',
        ...(await options.requirements?.(issue, repository)),
      }),
      assertAuthenticated: options.assertAuthenticated ?? (async () => {}),
    });
  }

  /** The requirements of the Issue — the version the workflow judged. */
  function requirementsOf(hash = 'hash-of-the-issue') {
    return {
      hash,
      status: 'unchanged' as const,
    };
  }

  /** A record of a workflow that was interrupted in a state. */
  function aRecord(id: string, state: WorkflowRecord['state']): WorkflowRecord {
    return {
      version: 1,
      id,
      state,
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
      orca: { repoId: 'repo-1' },
      agent: 'codex',
      backend: 'fake',
      maxIterations: 3,
      iterations: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('runs the loop and completes when the review approves the change', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review }),
    );

    expect(record.state).toBe('completed');
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]?.review?.verdict).toBe('APPROVE');
    // The worktree of the Issue was created and the agent worked in it.
    expect(record.worktree?.path).toBe('/wt/issue-59');
    expect(orca.started).toHaveLength(1);
    expect(orca.started[0]?.spec).toContain('The issue of the workflow');
    expect(orca.started[0]?.spec).toContain('Never push');
    // The review read the worktree and not the checkout of the user.
    expect(seen[0]?.cwd).toBe('/wt/issue-59');
    // The report of the workflow is written next to its record.
    const report = await readFile(path.join(getWorkflowDir(record.id), 'report.md'), 'utf-8');
    expect(report).toContain('completed');
    // The log of the steps tells how the workflow got there.
    const events = await readEvents(record.id);
    expect(events.map((event) => event.state)).toContain('completed');
  });

  it('sends the findings back to the agent and approves the second iteration', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    let commits = 0;
    orca.onCheck = () => {
      git.head = `head-sha-${++commits}`;
    };
    const { review } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
      { verdict: 'APPROVE', reason: 'the correction is right' },
    ]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review }),
    );

    expect(record.state).toBe('completed');
    expect(record.iterations).toHaveLength(2);
    // The findings went back to the agent — with the whole of them.
    expect(orca.sent).toHaveLength(1);
    expect(orca.sent[0]?.to).toBe('dispatch:dispatch-1');
    expect(orca.sent[0]?.body).toContain('F-1');
    expect(orca.sent[0]?.body).toContain('The check does not run');
    // The first iteration keeps the review that asked for the corrections.
    expect(record.iterations[0]?.review?.verdict).toBe('REQUEST CHANGES');
    expect(record.iterations[1]?.review?.verdict).toBe('APPROVE');
  });

  it('blocks when the limit of the iterations is reached', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
    ]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend(), maxIterations: 1 },
      contextOf(orca, git, { review }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('limit of 1 iterations');
  });

  it('blocks when the head of the worktree changed during the review', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    // The worktree moves under the review: the review judged another commit.
    const moving = async (request: WorkflowReviewRequest) => {
      const run = await review(request);
      git.head = 'head-sha-2';
      return run;
    };

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review: moving }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('changed during the review');
  });

  it('blocks when the issue changed while the workflow ran', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    let reads = 0;

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, {
        review,
        requirements: async () => {
          reads += 1;
          // The Issue is read again after the review: it has changed since.
          return requirementsOf(reads > 1 ? 'another-hash' : 'hash-of-the-issue');
        },
      }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('changed while the workflow ran');
  });

  it('blocks when a step of the review did not pass', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      {
        verdict: 'APPROVE',
        reason: 'the change is correct',
        steps: [...PASSED_STEPS, { id: 'verify-findings', status: 'failed' }],
      },
    ]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('The review is incomplete');
  });

  it('blocks when the state of the agent is unknown', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // A worker that reports neither an outcome nor a failure has not settled.
    orca.messages = [{ type: 'worker_done', text: 'I am done' }];

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('The state of the agent is unknown');
  });

  it('blocks when the agent reports a failure', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [{ type: 'worker_done', outcome: 'failed', text: 'the build breaks' }];

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('The agent did not finish the task');
  });

  it('does not start a second agent when a worker is already there', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.workers = [{ dispatchId: 'dispatch-1', taskId: 'task-1', state: 'working' }];
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review }),
    );

    expect(orca.started).toHaveLength(0);
    expect(record.state).toBe('completed');
    expect(record.orca?.dispatchId).toBe('dispatch-1');
  });

  it('waits for the agent and continues after a resume', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The agent says nothing: the workflow gives the turn back.
    orca.messages = [];
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    const ctx = contextOf(orca, git, { review, waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(record.state).toBe('implementation-running');
    expect(orca.started).toHaveLength(1);
    // The workflow is on the disk and can be continued.
    expect(await listWorkflows()).toContain(record.id);
    const loaded = await loadWorkflow(record.id);
    expect(loaded.state).toBe('implementation-running');

    // The agent finishes: the workflow continues where it stopped.
    git.head = 'head-sha-1';
    orca.messages = [{ type: 'worker_done', outcome: 'succeeded', text: 'the work is done' }];
    const resumed = await resumeWorkflow(record.id, ctx);

    expect(resumed.state).toBe('completed');
    // The agent was not started a second time.
    expect(orca.started).toHaveLength(1);
  });

  it('stops a workflow and keeps its state', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );
    const stopped = await stopWorkflow(record.id, ctx);

    expect(stopped.state).toBe('cancelled');
    expect(orca.stopped).toContain('dispatch-1');
    expect((await loadWorkflow(record.id)).state).toBe('cancelled');
  });

  it('does not claim that the workflow stopped when the agent could not be stopped', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });
    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );
    // The runtime refuses the stop: the agent may still work in the worktree.
    orca.stopError = new Error('the runtime is gone');

    const stopped = await stopWorkflow(record.id, ctx);

    expect(stopped.state).toBe('blocked');
    expect(stopped.blocked).toContain('could not be stopped');
    expect((await loadWorkflow(record.id)).state).toBe('blocked');
  });

  it('does not create a worktree when the gh CLI is not authenticated', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const ctx = contextOf(orca, git, {
      assertAuthenticated: async () => {
        throw new Error('The gh CLI is not installed or not authenticated');
      },
    });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('not authenticated');

    expect(orca.created).toHaveLength(0);
    const [id] = await listWorkflows();
    expect((await loadWorkflow(id)).state).toBe('blocked');
  });

  it('does not create a worktree when the checkout has no repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    git.repositoryName = '';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('no origin remote');

    expect(orca.created).toHaveLength(0);
  });

  it('does not create a worktree when the Orca runtime is not ready', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.ready = false;
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('not ready');

    expect(orca.created).toHaveLength(0);
  });

  it('does not create a worktree when the runtime cannot orchestrate', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.capabilities = ['worktree.create'];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('capability');

    expect(orca.created).toHaveLength(0);
  });

  it('does not create a worktree when the repository is not registered in Orca', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.repos = [];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('not registered in Orca');

    expect(orca.created).toHaveLength(0);
  });

  it('creates the worktree on the ref the user named', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const ctx = contextOf(orca, git);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend(), baseRef: 'release/2.x' },
      ctx,
    );

    expect(orca.created[0]?.baseRef).toBe('release/2.x');
    expect(record.worktree?.baseRef).toBe('release/2.x');
  });

  it('adopts the worktree that is already there instead of creating a second one', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree was created, but the answer of the command was lost before
    // the workflow could write it down.
    orca.worktrees = [
      { id: 'wt-9', path: '/wt/issue-59', name: 'issue-59', branch: '10x-chat/issue-59' },
    ];
    const ctx = contextOf(orca, git);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(orca.created).toHaveLength(0);
    expect(record.worktree?.id).toBe('wt-9');
  });

  it('does not start a second agent when two processes resume the same workflow', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });
    // The workflow was interrupted before the agent started.
    const record = aRecord('issue-59-aaaaaaaa', 'worktree-created');
    await saveWorkflow(record);

    await Promise.all([resumeWorkflow(record.id, ctx), resumeWorkflow(record.id, ctx)]);

    expect(orca.started).toHaveLength(1);
    expect((await loadWorkflow(record.id)).state).toBe('implementation-running');
  });

  it('does not overwrite a workflow that another process moved', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    // Another process stops the workflow while the review runs.
    const stopping = async (request: WorkflowReviewRequest) => {
      const run = await review(request);
      const [id] = await listWorkflows();
      const stored = await loadWorkflow(id);
      await saveWorkflow({ ...stored, state: 'cancelled' });
      return run;
    };
    const ctx = contextOf(orca, git, { review: stopping });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('another process moved it');

    const [id] = await listWorkflows();
    expect((await loadWorkflow(id)).state).toBe('cancelled');
  });

  it('keeps the evidence of the iteration when the findings cannot be sent', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    let commits = 0;
    orca.onCheck = () => {
      git.head = `head-sha-${++commits}`;
    };
    const { review, seen } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
    ]);
    // The mailbox of the Run does not answer.
    orca.sendError = new Error('the run is gone');
    const ctx = contextOf(orca, git, { review });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the run is gone');

    const [id] = await listWorkflows();
    const record = await loadWorkflow(id);
    expect(record.state).toBe('blocked');
    // The review of the iteration is kept, and no second iteration was opened
    // for corrections that never arrived.
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]?.review?.verdict).toBe('REQUEST CHANGES');
    expect(seen).toHaveLength(1);
  });
});

describe('the store of the workflows', () => {
  const originalEnv = process.env;
  let home = '';

  beforeEach(async () => {
    process.env = { ...originalEnv };
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /** A record of a workflow — the smallest one the store accepts. */
  function aRecord(id = 'issue-59-20260101000000-abcd1234'): WorkflowRecord {
    return {
      version: 1,
      id,
      state: 'created',
      repository: 'gazon1/10x-chat',
      issue: {
        number: 59,
        url: 'https://github.com/gazon1/10x-chat/issues/59',
        title: 'The issue',
        body: 'The body',
        hash: 'hash-of-the-issue',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      agent: 'codex',
      backend: 'fake',
      maxIterations: 3,
      iterations: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('writes the record and reads it back', async () => {
    const record = aRecord();
    await saveWorkflow(record);

    const loaded = await loadWorkflow(record.id);
    expect(loaded.id).toBe(record.id);
    expect(loaded.state).toBe('created');
    expect(loaded.issue.hash).toBe('hash-of-the-issue');
  });

  it('keeps the files of a workflow private', async () => {
    if (process.platform === 'win32') return;
    const record = aRecord();
    await saveWorkflow(record);

    const dir = getWorkflowDir(record.id);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, 'workflow.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a record of another format', async () => {
    const record = aRecord();
    await saveWorkflow(record);
    // A record of another version of the format is not a record: a workflow
    // that read one would move through states it never entered.
    const file = path.join(getWorkflowDir(record.id), 'workflow.json');
    const broken = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...broken, version: 2 }), 'utf-8');

    await expect(loadWorkflow(record.id)).rejects.toThrow('another format');
  });

  it('reports the workflows of the store', async () => {
    await saveWorkflow(aRecord('issue-59-aaaaaaaa'));
    await saveWorkflow(aRecord('issue-60-bbbbbbbb'));

    expect(await listWorkflows()).toEqual(['issue-59-aaaaaaaa', 'issue-60-bbbbbbbb']);
  });
});

describe('the transitions of a workflow', () => {
  it('knows the states a workflow cannot leave', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('created')).toBe(false);
  });

  it('allows the steps of the loop and refuses the others', () => {
    expect(canTransition('created', 'issue-loaded')).toBe(true);
    expect(canTransition('fixes-requested', 'implementation-running')).toBe(true);
    expect(canTransition('created', 'completed')).toBe(false);
    expect(() => assertTransition('created', 'completed')).toThrow(
      "cannot move from 'created' to 'completed'",
    );
  });
});
