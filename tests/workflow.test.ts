import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import { hashRequirements } from '../src/pipeline/requirements.js';
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
  /** The comment a new worktree carries — the text of the user. */
  createdComment?: string;
  /** The messages the mailbox answers with. */
  messages: OrcaMessage[] = [
    { type: 'worker_done', outcome: 'succeeded', text: 'the work is done' },
  ];
  /** The state the worker reports. */
  workerState = 'working';
  /** The structured outcome the worker reports — it settles the Task. */
  workerOutcome?: string;
  /** The report of the worker. */
  workerReport?: string;
  /** The checkpoints the workflow wrote into the comment of the worktree. */
  readonly comments: { selector: string; comment: string }[] = [];
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
  /** What the runtime does when the state of the worker is read. */
  onWorkerShow?: () => void;
  /** What the runtime answers when the worker is stopped. */
  stopError?: Error;
  /** The answer of the start command was lost — the worker is there all the same. */
  workerStartError?: Error;
  /** The start command that fails — the first one by default. */
  workerStartFailAt = 1;
  /** The worker that the lost answer started. */
  lostWorker?: OrcaWorker;

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
      ...(this.createdComment ? { comment: this.createdComment } : {}),
    };
    this.worktrees.push(worktree);
    return worktree;
  }

  async worktreeList() {
    return this.worktrees;
  }

  async worktreeComment(selector: string, comment: string) {
    this.comments.push({ selector, comment });
    const worktree = this.worktrees.find((entry) => entry.id === selector);
    if (worktree) worktree.comment = comment;
  }

  async runCreate(objective: string) {
    this.runs.push(objective);
    return 'run-1';
  }

  async workerStart(options: { spec: string; worktree: string }) {
    this.started.push({ spec: options.spec, worktree: options.worktree });
    const number = this.started.length;
    if (this.workerStartError && number >= this.workerStartFailAt) {
      // The runtime started the worker and the answer never came.
      if (this.lostWorker) this.workers.push(this.lostWorker);
      throw this.workerStartError;
    }
    // Every worker has its own Dispatch — the corrections are a new one.
    const worker = { dispatchId: `dispatch-${number}`, taskId: `task-${number}`, state: 'working' };
    // The runtime knows the worker — a workflow that starts a second one is
    // visible to the next run.
    this.workers.push(worker);
    return worker;
  }

  async workerShow(dispatchId: string) {
    this.onWorkerShow?.();
    const worker = this.workers.find((entry) => entry.dispatchId === dispatchId);
    // A worker that was stopped reports it — the runtime knows it.
    const state = worker?.state === 'stopped' ? 'stopped' : this.workerState;
    return {
      dispatchId,
      state,
      ...(this.workerOutcome ? { outcome: this.workerOutcome } : {}),
      ...(this.workerReport ? { report: this.workerReport } : {}),
    };
  }

  async workerList() {
    return this.workers;
  }

  async workerStop(dispatchId: string) {
    if (this.stopError) throw this.stopError;
    this.stopped.push(dispatchId);
    const worker = this.workers.find((entry) => entry.dispatchId === dispatchId);
    if (worker) worker.state = 'stopped';
    this.workerState = 'stopped';
  }

  async check() {
    this.onCheck?.();
    // The worker that reported the completion is settled — the runtime knows
    // it, and a worker that is settled does not take new work.
    if (this.messages.some((message) => message.type === 'worker_done')) {
      const worker = this.workers[this.workers.length - 1];
      if (worker) worker.state = 'settled';
    }
    return this.messages;
  }
}

/** The git of the tests — the head of the worktree is a variable. */
class FakeGit implements WorkflowGit {
  head = 'base-sha';
  /** The repository of the checkout — an empty name is a broken checkout. */
  repositoryName = 'gazon1/10x-chat';
  /** The base ref is unknown — the git of the checkout cannot tell. */
  baseRefError?: Error;
  /** The root of the checkout — the clone of the user. */
  rootPath = '/repo';
  /** The paths of the worktree that are not committed. */
  dirtyPaths: string[] = [];

  async repository() {
    return this.repositoryName;
  }

  async revParse() {
    return this.head;
  }

  async defaultBaseRef() {
    if (this.baseRefError) throw this.baseRefError;
    return 'main';
  }

  async root() {
    return this.rootPath;
  }

  async dirty() {
    return this.dirtyPaths;
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
  /** The commit the review compared the change with. */
  baseSha?: string;
}

const PASSED_STEPS: StepOutcome[] = [
  { id: 'collect-context', status: 'passed' },
  { id: 'build-bundle', status: 'passed' },
  { id: 'review-correctness', status: 'passed' },
  { id: 'review-architecture', status: 'passed' },
  { id: 'review-tests', status: 'passed' },
  { id: 'verify-findings', status: 'passed' },
  { id: 'normalize-findings', status: 'passed' },
  { id: 'render-report', status: 'passed' },
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
        baseSha: next.baseSha ?? 'base-sha',
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
      /** The `gh` CLI of the machine is used — the real integration. */
      useRealGh?: boolean;
      /** The checkout of the workflow — the `gh` CLI runs there. */
      cwd?: string;
    } = {},
  ): WorkflowContext {
    let tick = 0;
    const cwd = options.cwd ?? '/repo';
    return createWorkflowContext({
      orca,
      cwd,
      git,
      backend: createFakeBackend(),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)),
      waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
      ...(options.review ? { review: options.review } : {}),
      ...(options.useRealGh
        ? {}
        : {
            readRequirements: async (issue: number, repository: string) => ({
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
          }),
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
    // The corrections are a follow-up supervised work item: a new worker, and
    // the findings are in its brief.
    expect(orca.started).toHaveLength(2);
    expect(orca.started[1]?.spec).toContain('F-1');
    expect(orca.started[1]?.spec).toContain('The check does not run');
    expect(record.orca?.dispatchId).toBe('dispatch-2');
    // The finished Dispatch is not asked to work again.
    expect(orca.sent).toHaveLength(0);
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
          // The Issue is read when the agent works and once more after the
          // review: it has changed since the workflow started.
          return requirementsOf(reads > 2 ? 'another-hash' : 'hash-of-the-issue');
        },
      }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('changed while the workflow ran');
  });

  it('blocks when the issue changed while the agent was working', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    let reads = 0;

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, {
        review,
        requirements: async () => {
          reads += 1;
          // The Issue changed while the agent worked: the change was made
          // against requirements that are not the current ones.
          return requirementsOf(reads > 1 ? 'another-hash' : 'hash-of-the-issue');
        },
      }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('changed while the agent was working');
    // The change is never judged against the version of the Issue that the
    // workflow does not know any more.
    expect(seen).toHaveLength(0);
  });

  it('does not review a worktree that is not clean', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    // The agent left a change in the worktree that it did not commit.
    git.dirtyPaths = [' M src/workflow/orchestrator.ts', '?? src/workflow/new.ts'];
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The review reads the committed state only — an uncommitted change is
    // nobody's judged change.
    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('not clean');
    expect(record.blocked).toContain('src/workflow/orchestrator.ts');
    expect(seen).toHaveLength(0);
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

  it('blocks when the review did not render its report', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    // A review that approved the change but never rendered its report has not
    // produced the report the workflow refers to.
    const { review } = fakeReview(git, [
      {
        verdict: 'APPROVE',
        reason: 'the change is correct',
        steps: PASSED_STEPS.filter((step) => step.id !== 'render-report'),
      },
    ]);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git, { review }),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('render-report');
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

  it('does not treat a settled worker as a success without a structured outcome', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The Dispatch says that it succeeded, but it reports no outcome: the
    // result of the Task is nobody's confirmation.
    orca.workerState = 'succeeded';
    orca.messages = [];

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      contextOf(orca, git),
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('unknown');
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

  it('stops the workers of the run when the dispatch is not written down', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });
    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );
    // The Dispatch is written down after the start command answers: a stop in
    // that window must not leave the agent in the worktree.
    const stored = await loadWorkflow(record.id);
    await saveWorkflow({ ...stored, orca: { repoId: 'repo-1', runId: 'run-1' } });

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

  it('never works in the checkout of the user', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The checkout of the repository carries the branch of the Issue.
    orca.worktrees = [
      {
        id: 'wt-main',
        path: '/repo',
        name: 'main',
        branch: '10x-chat/issue-59',
        isMainWorktree: true,
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the checkout of the repository');

    expect(orca.created).toHaveLength(0);
  });

  it('never shares the worktree with another workflow', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree of the Issue belongs to another run.
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        comment: '10x-chat workflow issue-59-other: worktree-created — the worktree is there',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('belongs to the workflow issue-59-other');

    expect(orca.created).toHaveLength(0);
    expect(orca.started).toHaveLength(0);
  });

  it('never takes over a worktree that carries the comment of somebody else', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        comment: 'my own worktree, do not touch it',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('comment of somebody else');

    expect(orca.created).toHaveLength(0);
  });

  it('never takes over a worktree that already has changes', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        head: 'other-sha',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('already has changes');

    expect(orca.started).toHaveLength(0);
  });

  it('refuses to start a second workflow of the same Issue', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const first = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );
    expect(first.state).toBe('implementation-running');

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(`already has a running workflow: ${first.id}`);

    // The agent of the first workflow is the only one that runs.
    expect(orca.started).toHaveLength(1);
  });

  it('refuses to guess the base ref', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The checkout does not know its default branch.
    git.baseRefError = new Error(
      'The default branch of origin is unknown — name the ref yourself: 10x-chat workflow start --base <ref>.',
    );
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('The default branch of origin is unknown');

    expect(orca.created).toHaveLength(0);
  });

  it('blocks when the worker settles without a structured outcome', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worker is terminal, but the Task has no result.
    orca.workerState = 'settled';
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('reported no structured outcome');
  });

  it('takes the structured outcome of the worker', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.workerState = 'settled';
    orca.workerOutcome = 'succeeded';
    orca.workerReport = 'the change is done and the checks pass';
    orca.messages = [];
    // The agent committed before it reported the result.
    orca.onWorkerShow = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(record.state).toBe('completed');
    // The report of the agent is the evidence of the implementation.
    expect(record.iterations[0]?.agentReport).toContain('the checks pass');
  });

  it('writes the checkpoint of the transition without losing the comment of the user', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    // The user wrote a note in the worktree of the Issue.
    orca.createdComment = 'the note of the user';
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    const checkpoint = orca.comments.at(-1);
    expect(checkpoint?.selector).toBe('wt-1');
    expect(checkpoint?.comment).toContain(`10x-chat workflow ${record.id}`);
    // The text of the user is kept: the checkpoint is read before it is written.
    expect(checkpoint?.comment).toContain('the note of the user');
  });

  it('carries the evidence of the implementation into the report', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend(), maxIterations: 1 },
      ctx,
    );

    const report = await readFile(path.join(getWorkflowDir(record.id), 'report.md'), 'utf-8');
    // The worktree, the branch and the exact commits.
    expect(report).toContain('wt-1');
    expect(report).toContain('base-sha');
    expect(report).toContain('head-sha-1');
    // The summary of the agent and the risks that stand.
    expect(report).toContain('the work is done');
    expect(report).toContain('The check does not run');
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

  it('keeps the evidence of the iteration when the corrections cannot be started', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    let commits = 0;
    orca.onCheck = () => {
      git.head = `head-sha-${++commits}`;
    };
    const { review, seen } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
    ]);
    // The runtime refuses the worker of the corrections.
    orca.workerStartError = new Error('the runtime refused the worker');
    orca.workerStartFailAt = 2;
    const ctx = contextOf(orca, git, { review });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the runtime refused the worker');

    const [id] = await listWorkflows();
    const record = await loadWorkflow(id);
    expect(record.state).toBe('blocked');
    // The review of the iteration is kept, and no second iteration was opened
    // for corrections that never arrived.
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]?.review?.verdict).toBe('REQUEST CHANGES');
    expect(seen).toHaveLength(1);
  });

  it('never adopts a worktree of another branch', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // A worktree of the name of the Issue, but of another branch: the name is
    // not the proof of the ownership.
    orca.worktrees = [
      {
        id: 'wt-other',
        path: '/wt/other',
        name: 'issue-59',
        branch: 'feature/other',
        head: 'base-sha',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the workflow needs the branch 10x-chat/issue-59');

    // A second worktree of the same name would collide with the first one.
    expect(orca.created).toHaveLength(0);
  });

  it('reviews the change against the commit the worktree started from', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The base of the review is the commit of the worktree, not the ref it was
    // created from: a ref that moves is a comparison of another change.
    expect(seen[0]?.base).toBe('base-sha');
    expect(record.state).toBe('completed');
  });

  it('blocks when the review compared the change with another base', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct', baseSha: 'another-base' },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('another');
  });

  it('blocks when the review did not run every step', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      {
        verdict: 'APPROVE',
        reason: 'the change is correct',
        steps: PASSED_STEPS.filter((step) => step.id !== 'review-tests'),
      },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The absence of a failure is not the evidence of a judgment.
    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('review-tests');
  });

  it('takes the worker of a lost answer instead of starting a second one', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // Orca started the worker and the answer of the command was lost.
    orca.workerStartError = new Error('the answer of the command was lost');
    orca.lostWorker = { dispatchId: 'dispatch-lost', taskId: 'task-lost', state: 'working' };
    // The agent is still working: the workflow waits for it.
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The worker that is already there is adopted — a second agent would work
    // in the same worktree.
    expect(orca.started).toHaveLength(1);
    expect(record.state).toBe('implementation-running');
    expect(record.orca?.dispatchId).toBe('dispatch-lost');
  });

  it('keeps the identifiers of another process when the workflow is stopped', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const started = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // Another process writes the record while this one holds an older copy.
    const other = await loadWorkflow(started.id);
    other.orca = { repoId: 'repo-1', runId: 'run-of-the-other-process' };
    await saveWorkflow(other);

    const stopped = await stopWorkflow(started.id, ctx);
    expect(stopped.state).toBe('cancelled');
    // The stop must not lose the Run of the other process.
    const stored = await loadWorkflow(started.id);
    expect(stored.orca?.runId).toBe('run-of-the-other-process');
  });

  it('takes the registration of the checkout when the repository is registered twice', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.repos = [
      {
        id: 'repo-mirror',
        path: '/mirror',
        displayName: '10x-chat',
        canonicalKey: 'github.com/gazon1/10x-chat',
      },
      {
        id: 'repo-1',
        path: '/repo',
        displayName: '10x-chat',
        canonicalKey: 'github.com/gazon1/10x-chat',
      },
    ];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The clone of the user wins over the mirror that is first in the list.
    expect(record.orca?.repoId).toBe('repo-1');
  });

  it('refuses to guess which registration of the repository is the checkout', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.repos = [
      {
        id: 'repo-a',
        path: '/clone',
        displayName: '10x-chat',
        canonicalKey: 'github.com/gazon1/10x-chat',
      },
      {
        id: 'repo-b',
        path: '/mirror',
        displayName: '10x-chat',
        canonicalKey: 'github.com/gazon1/10x-chat',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('registered in Orca at several paths');

    expect(orca.created).toHaveLength(0);
  });

  it('reads the Issue through the gh CLI of the machine', async () => {
    // The real integration: the `gh` CLI of the PATH answers the Issue, and
    // the workflow reads it without a fake in between.
    const bin = path.join(home, 'bin');
    await mkdir(bin, { recursive: true });
    const log = path.join(home, 'gh-args.txt');
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
    const gh = path.join(bin, 'gh');
    await writeFile(
      gh,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1 $2" in\n"auth status") exit 0;;\n"issue view") cat "${issueFile}";;\nesac\n`,
      'utf-8',
    );
    await chmod(gh, 0o755);
    // The `gh` CLI is found through the PATH of the process — the environment
    // of the child processes is the real one, not the copy of the test.
    const previousPath = originalEnv.PATH;
    originalEnv.PATH = `${bin}:${previousPath ?? ''}`;
    const checkout = path.join(home, 'checkout');
    await mkdir(checkout, { recursive: true });

    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [{ verdict: 'APPROVE', reason: 'the change is correct' }]);
    const ctx = contextOf(orca, git, { review, useRealGh: true, cwd: checkout });

    try {
      const record = await startWorkflow(
        { issue: 59, cwd: checkout, backend: createFakeBackend() },
        ctx,
      );

      expect(record.state).toBe('completed');
      // The requirements are the ones the CLI answered with.
      expect(record.issue.title).toBe('The issue of the workflow');
      expect(record.issue.hash).toBe(
        hashRequirements('The issue of the workflow', 'The body of the issue.'),
      );
      // The CLI was asked for the authentication and for the Issue itself.
      const args = await readFile(log, 'utf-8');
      expect(args).toContain('auth status');
      expect(args).toContain('issue view 59 --repo gazon1/10x-chat --json number,url,title,body');
    } finally {
      originalEnv.PATH = previousPath;
    }
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

  it('refuses a record that is a link to a file outside of the store', async () => {
    if (process.platform === 'win32') return;
    const record = aRecord();
    await saveWorkflow(record);
    const dir = getWorkflowDir(record.id);
    const file = path.join(dir, 'workflow.json');
    const outside = path.join(home, 'outside.json');
    await writeFile(outside, JSON.stringify({ version: 1 }), 'utf-8');
    await rm(file);
    await symlink(outside, file);

    // The record of a workflow is its owner's: a link in the store would take
    // the read outside of it.
    await expect(loadWorkflow(record.id)).rejects.toThrow('symbolic link');
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
