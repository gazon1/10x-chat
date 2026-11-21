import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiBackend } from '../src/backend/contract.js';
import { createFakeBackend, FAKE_BACKEND_CAPABILITIES } from '../src/backend/fake.js';
import type {
  OrcaApi,
  OrcaMessage,
  OrcaRepo,
  OrcaRun,
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
import { nodeWorkflowGit } from '../src/workflow/git.js';
import {
  createWorkflowContext,
  resumeWorkflow,
  startWorkflow,
  stopWorkflow,
  type WorkflowContext,
  type WorkflowReviewRequest,
} from '../src/workflow/orchestrator.js';
import {
  appendEvent,
  listWorkflows,
  loadWorkflow,
  readEvents,
  saveWorkflow,
} from '../src/workflow/store.js';
import { assertTransition, canTransition, isTerminal } from '../src/workflow/transitions.js';
import type { WorkflowRecord } from '../src/workflow/types.js';

const execFileAsync = promisify(execFile);

/** Run a git command in a directory and say what it printed. */
async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args],
    { cwd },
  );
  return String(stdout).trim();
}

/**
 * The tests of the development workflow.
 *
 * Nothing here touches Orca, GitHub or a model: the Orca adapter, the git of
 * the checkout and the review of the change are the seams of the workflow, and
 * every test replaces them with a fake that answers the way the real one does.
 */

/**
 * A backend that records the prompts it got — the evidence of the review.
 *
 * The answers are the ones of a reviewer without a finding: the review of the
 * change is the pipeline of the repository, and the backend is the only part
 * of it that is faked.
 */
function recordingBackend(): { backend: AiBackend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: AiBackend = {
    name: 'fake',
    capabilities: FAKE_BACKEND_CAPABILITIES,
    testDouble: true,
    async ask(request) {
      prompts.push(request.prompt);
      const answer = request.prompt.startsWith('# Verification')
        ? JSON.stringify({ verdicts: [] })
        : JSON.stringify({ findings: [], decisions: [] });
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          text: answer,
          markdown: answer,
          truncated: false,
          submission: 'submitted',
        },
      };
    },
    async status(requestId) {
      return { requestId, submission: 'submitted' };
    },
    async resume(request) {
      return backend.ask(request);
    },
    async cancel() {
      return { ok: true, value: { cancelled: true } };
    },
  };
  return { backend, prompts };
}

/** The Orca of the tests — it records what the workflow asked of it. */
class FakeOrca implements OrcaApi {
  readonly started: { spec: string; worktree: string }[] = [];
  readonly sent: { to: string; subject: string; body: string }[] = [];
  readonly stopped: string[] = [];
  readonly runs: string[] = [];
  /** The worktrees the workflow created — a second one is a defect. */
  readonly created: {
    name: string;
    branch: string;
    baseRef: string;
    issue?: number;
    comment?: string;
  }[] = [];
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
  /**
   * Whether the runtime names the Dispatch of the worker that reported.
   *
   * The Run is reused between the iterations of the workflow: a message that
   * names no Dispatch belongs to the worker that still works, and to nobody
   * else when the Run has more than one of them.
   */
  nameTheDispatch = true;
  /** The worktrees cannot be read — the runtime does not offer the operation. */
  worktreeListError?: Error;
  /** The state the worker reports. */
  workerState = 'working';
  /** The structured outcome the worker reports — it settles the Task. */
  workerOutcome?: string;
  /** The report of the worker. */
  workerReport?: string;
  /** The checkpoints the workflow wrote into the comment of the worktree. */
  readonly comments: { selector: string; comment: string }[] = [];
  ready = true;
  capabilities = ['orchestration.contract.v1', 'worktree.create-agent-options.v1'];
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
  /** The path of the worktree that is created — its identity is checked. */
  worktreePath = '/wt/issue-59';
  /** The answer of the create command was lost — the worktree is there all the same. */
  worktreeCreateError?: Error;
  /** The Runs of the orchestration — the answer of a lost runCreate. */
  runListEntries: OrcaRun[] = [];
  /** The answer of the runCreate was lost. */
  runCreateError?: Error;
  /** What the runtime does when the Run is created. */
  onRunCreate?: () => void;
  /** What the runtime does when the worker is started. */
  onWorkerStart?: () => void | Promise<void>;

  async status() {
    return { ready: this.ready, capabilities: this.capabilities };
  }

  async repoList() {
    return this.repos;
  }

  async worktreeCreate(options: {
    name: string;
    branch: string;
    baseRef: string;
    issue?: number;
    comment?: string;
  }) {
    this.created.push(options);
    const comment = this.createdComment ?? options.comment;
    const worktree = {
      id: 'wt-1',
      path: this.worktreePath,
      name: options.name,
      branch: options.branch,
      ...(options.issue !== undefined ? { linkedIssue: options.issue } : {}),
      ...(comment ? { comment } : {}),
    };
    this.worktrees.push(worktree);
    // The answer of the command was lost — the worktree is there all the same.
    if (this.worktreeCreateError) throw this.worktreeCreateError;
    return worktree;
  }

  async worktreeList() {
    if (this.worktreeListError) throw this.worktreeListError;
    return this.worktrees;
  }

  async worktreeComment(selector: string, comment: string) {
    this.comments.push({ selector, comment });
    const worktree = this.worktrees.find((entry) => entry.id === selector);
    if (worktree) worktree.comment = comment;
  }

  async runCreate(objective: string) {
    this.runs.push(objective);
    this.onRunCreate?.();
    if (this.runCreateError) throw this.runCreateError;
    return 'run-1';
  }

  async runList() {
    return this.runListEntries;
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
    await this.onWorkerStart?.();
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
    // The runtime names the Dispatch of the worker that reported: the Run is
    // reused between the iterations of the workflow, and a message without a
    // Dispatch belongs to nobody that the workflow can prove.
    const current = this.workers[this.workers.length - 1]?.dispatchId;
    return this.messages.map((message) =>
      message.dispatchId || !current || !this.nameTheDispatch
        ? message
        : { ...message, dispatchId: current },
    );
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
  /** The paths that are not committed — the map of the paths. */
  dirtyByPath: Record<string, string[]> = {};
  /** The commits of the paths — the map of the paths. */
  heads: Record<string, string> = {};
  /**
   * The common directory of the git of the paths — the map of the paths that
   * belong to another repository. A path that is not in the map belongs to the
   * repository of the checkout.
   */
  commonDirs: Record<string, string> = {};
  /** The branches of the paths — the map of the paths that are on a branch. */
  branches: Record<string, string> = {};
  /** The repositories of the paths — the map of the paths of another repository. */
  repositories: Record<string, string> = {};
  /**
   * The physical root of the paths — the map of the paths that resolve
   * somewhere else. A path that is not in the map is its own root.
   */
  toplevels: Record<string, string> = {};
  /**
   * The main worktree of the repository of the paths — the map of the paths.
   * A path that is not in the map belongs to the main worktree of the
   * checkout of the user.
   */
  mainWorktrees: Record<string, string> = {};
  /** The branch of the worktree of the Issue — the branch the workflow wants. */
  defaultBranch = '10x-chat/issue-59';
  /** The URL of the origin remote of the checkout. */
  remote = 'https://github.com/gazon1/10x-chat.git';

  async repository(cwd: string) {
    return this.repositories[cwd] ?? this.repositoryName;
  }

  async remoteUrl() {
    return this.remote;
  }

  async revParse(cwd: string) {
    return this.heads[cwd] ?? this.head;
  }

  async defaultBaseRef() {
    if (this.baseRefError) throw this.baseRefError;
    return 'main';
  }

  async root() {
    return this.rootPath;
  }

  async dirty(cwd: string) {
    return this.dirtyByPath[cwd] ?? this.dirtyPaths;
  }

  async commonDir(cwd: string) {
    return this.commonDirs[cwd] ?? '/repo/.git';
  }

  async branch(cwd: string) {
    return this.branches[cwd] ?? this.defaultBranch;
  }

  async toplevel(cwd: string) {
    return this.toplevels[cwd] ?? cwd;
  }

  async mainWorktree(cwd: string) {
    return this.mainWorktrees[cwd] ?? '/repo';
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
  /** The version of the requirements the review read. */
  requirementsHash?: string;
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
        // The version of the requirements that the review really read — the
        // approval is bound to it.
        requirements: {
          repository: 'gazon1/10x-chat',
          number: request.issue ?? 59,
          url: `https://github.com/gazon1/10x-chat/issues/${request.issue ?? 59}`,
          title: 'The issue of the workflow',
          body: 'The body of the issue.',
          hash: next.requirementsHash ?? 'hash-of-the-issue',
          status: 'initial',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
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
  // The environment of the process is changed in place, not replaced with a
  // copy of it: the child processes inherit the environment that the process
  // has when they are started, and a copy of it is not that environment.
  const originalHome = process.env.TEN_X_CHAT_HOME;
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.TEN_X_CHAT_HOME;
    else process.env.TEN_X_CHAT_HOME = originalHome;
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
      /** The clock of the test — the state of the workflow may change in it. */
      now?: () => Date;
      /** The instructions of the repository — the `AGENTS.md` of the checkout. */
      readInstructions?: (cwd: string) => Promise<string>;
      /** The environment of the `gh` CLI — the CLI of another PATH. */
      ghEnv?: NodeJS.ProcessEnv;
    } = {},
  ): WorkflowContext {
    let tick = 0;
    const cwd = options.cwd ?? '/repo';
    return createWorkflowContext({
      orca,
      cwd,
      git,
      backend: createFakeBackend(),
      now: options.now ?? (() => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++))),
      waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
      ...(options.review ? { review: options.review } : {}),
      ...(options.readInstructions ? { readInstructions: options.readInstructions } : {}),
      ...(options.ghEnv ? { ghEnv: options.ghEnv } : {}),
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

  /** The worktree of Orca that the hand-written records of the tests name. */
  function anOrcaWorktree(): OrcaWorktree {
    return { id: 'wt-1', path: '/wt/issue-59', branch: '10x-chat/issue-59' };
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
    // The agent left a change in the worktree that it did not commit — it
    // happened while the agent worked, so the start of the agent was clean.
    orca.onWorkerStart = () => {
      git.dirtyPaths = [' M src/workflow/orchestrator.ts', '?? src/workflow/new.ts'];
    };
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

  it('does not start an agent in a worktree that is not clean', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree carries changes that nobody committed — the agent would
    // carry them into the change of the Issue.
    git.dirtyPaths = [' M src/workflow/orchestrator.ts'];
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    const ctx = contextOf(orca, git, { review });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/not clean/);

    // The workflow is blocked — the agent never worked in a dirty checkout.
    const [id] = await listWorkflows();
    const stored = await loadWorkflow(id);
    expect(stored.state).toBe('blocked');
    expect(stored.blocked).toContain('not clean');
    expect(orca.started).toHaveLength(0);
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
    orca.capabilities = ['worktree.create-agent-options.v1'];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('capability');

    expect(orca.created).toHaveLength(0);
  });

  it('does not create a worktree when the runtime names only some verbs of the worktrees', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The runtime names two of the three verbs of the worktrees: it cannot
    // comment in a worktree, and the workflow needs that.
    orca.capabilities = ['orchestration.contract.v1', 'worktree.list', 'worktree.create'];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/worktree\.comment/);

    expect(orca.created).toHaveLength(0);
  });

  it('creates a worktree when the runtime names every verb of the worktrees', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.capabilities = [
      'orchestration.contract.v1',
      'worktree.list',
      'worktree.create',
      'worktree.comment',
    ];
    const ctx = contextOf(orca, git);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(orca.created).toHaveLength(1);
    expect(record.worktree?.id).toBe('wt-1');
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

  it('adopts the worktree of a lost answer instead of creating a second one', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree was created, but the answer of the command was lost before
    // the workflow could write it down. Orca links it to the Issue, and it
    // carries the name and the branch of the Issue — the proof that it is the
    // worktree of this Issue.
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        linkedIssue: 59,
      },
    ];
    const ctx = contextOf(orca, git);

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(orca.created).toHaveLength(0);
    expect(record.worktree?.id).toBe('wt-9');
  });

  it('takes over the worktree of a run that died before it wrote its mark', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree was created, but the answer of the command was lost — the
    // run that created it died before it could write it down.
    orca.worktreeCreateError = new Error('the answer of the create command was lost');
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the answer of the create command was lost');

    // The worktree carries the mark of the run that died — the workflow wrote
    // it at once.
    expect(orca.worktrees[0]?.comment).toContain('10x-chat workflow');

    // A new run of the same Issue takes that worktree over: it does not make
    // a second one, and it does not work in the worktree of somebody else.
    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    expect(orca.created).toHaveLength(1);
    expect(record.worktree?.id).toBe('wt-1');
  });

  it('never takes over a worktree that carries no proof of its owner', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // A worktree of somebody else: nobody wrote the mark of a workflow in it.
    orca.worktrees = [
      { id: 'wt-9', path: '/wt/issue-59', name: 'issue-59', branch: '10x-chat/issue-59' },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('carries no proof');

    expect(orca.created).toHaveLength(0);
    expect(orca.started).toHaveLength(0);
  });

  it('never takes over a worktree that is linked to another Issue', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        linkedIssue: 60,
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('linked to the Issue #60');

    expect(orca.created).toHaveLength(0);
  });

  it('does not guess which worktree is its own when Orca has two of them', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktrees = [
      { id: 'wt-8', path: '/wt/one', name: 'issue-59', branch: '10x-chat/issue-59' },
      { id: 'wt-9', path: '/wt/two', name: 'issue-59-old', branch: '10x-chat/issue-59' },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('does not guess which one is its own');

    expect(orca.created).toHaveLength(0);
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

  it('never works in a worktree that is a symbolic link to the checkout of the user', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The path of the worktree is its own path, but it names the checkout of
    // the user: the git of the checkout resolves it, and the agent would work
    // in the checkout of the user.
    orca.worktrees = [
      {
        id: 'wt-link',
        path: '/wt/link',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
        comment: '10x-chat workflow issue-59-link: created — issue #59',
      },
    ];
    git.toplevels['/wt/link'] = '/repo';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow('the checkout of the repository');

    expect(orca.created).toHaveLength(0);
    expect(orca.started).toHaveLength(0);
  });

  it('never works in a worktree that is the main worktree of the repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The repository is registered under a worktree of its own, and its main
    // worktree is somewhere else. The worktree of Orca is a symbolic link to
    // that main worktree — the checkout of the user.
    orca.repos = [
      {
        id: 'repo-1',
        path: '/clone',
        displayName: '10x-chat',
        canonicalKey: 'github.com/gazon1/10x-chat',
      },
    ];
    orca.worktrees = [
      {
        id: 'wt-main',
        path: '/wt/link-to-main',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
      },
    ];
    git.toplevels['/wt/link-to-main'] = '/clone-main';
    git.mainWorktrees['/clone'] = '/clone-main';
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

  it('refuses to start a second workflow of an Issue whose record cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    // The record of a workflow of the Issue is broken: it may still describe a
    // workflow that runs, and a second workflow of the Issue would be a second
    // agent in the same worktree.
    const broken = aRecord('issue-59-20260101000000-abcd1234', 'implementation-running');
    await saveWorkflow(broken);
    await writeFile(
      path.join(getWorkflowDir(broken.id), 'workflow.json'),
      '{ this is not a record',
      'utf-8',
    );
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/cannot be read/);

    // The broken record is not replaced and no agent works in the Issue.
    const kept = await readFile(path.join(getWorkflowDir(broken.id), 'workflow.json'), 'utf-8');
    expect(kept).toBe('{ this is not a record');
    expect(orca.started).toHaveLength(0);
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

  it('takes the ref of origin when the checkout has no local branch', async () => {
    // A checkout that fetched the remote only has `refs/remotes/origin/main`:
    // the base of the worktree is the ref of origin, not a name that does not
    // resolve.
    const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-git-'));
    const run = async (args: string[]) =>
      execFileAsync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    await run(['init', '-b', 'main']);
    await run(['commit', '--allow-empty', '-m', 'the first commit']);
    const { stdout } = await run(['rev-parse', 'HEAD']);
    const sha = stdout.trim();
    await run(['update-ref', 'refs/remotes/origin/main', sha]);
    await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    await run(['checkout', '--detach', sha]);
    await run(['branch', '-D', 'main']);

    expect(await nodeWorkflowGit.defaultBaseRef(dir)).toBe('origin/main');
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
    orca.worktrees = [anOrcaWorktree()];
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

  it('does not guess which worker is its own when the Run has two of them', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // Two agents work in the Run of the workflow: the workflow does not guess
    // which one is its own and starts no third agent next to them.
    orca.workers.push({ dispatchId: 'dispatch-a', taskId: 'task-a', state: 'working' });
    orca.workers.push({ dispatchId: 'dispatch-b', taskId: 'task-b', state: 'working' });
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/does not guess which one is its own/);

    expect(orca.started).toHaveLength(0);
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
    // The real integration: the `gh` CLI is really started, and the workflow
    // reads the Issue through it — the answer of the CLI of the PATH that the
    // workflow was given.
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
    // The `gh` CLI is the one of the PATH that the workflow is given: the
    // environment of the command is named, and the CLI of that PATH answers.
    const ghEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const checkout = path.join(home, 'checkout');
    await mkdir(checkout, { recursive: true });

    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      {
        verdict: 'APPROVE',
        reason: 'the change is correct',
        // The version of the requirements that the review read — the same
        // version the workflow started with.
        requirementsHash: hashRequirements('The issue of the workflow', 'The body of the issue.'),
      },
    ]);
    const ctx = contextOf(orca, git, { review, useRealGh: true, cwd: checkout, ghEnv });

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
  });

  describe('when the gh CLI cannot answer with the Issue', () => {
    /**
     * The workflow reads the Issue through the `gh` CLI of the machine — and
     * a CLI that cannot answer with the Issue stops the workflow before it
     * creates anything.
     */
    async function startWithGh(answer: string): Promise<{
      orca: FakeOrca;
      error: unknown;
    }> {
      const bin = path.join(home, 'bin');
      await mkdir(bin, { recursive: true });
      const gh = path.join(bin, 'gh');
      await writeFile(
        gh,
        `#!/bin/sh\ncase "$1 $2" in\n"auth status") exit 0;;\n"issue view") ${answer};;\nesac\n`,
        'utf-8',
      );
      await chmod(gh, 0o755);
      const ghEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
      const checkout = path.join(home, 'checkout');
      await mkdir(checkout, { recursive: true });

      const orca = new FakeOrca();
      const git = new FakeGit();
      const ctx = contextOf(orca, git, { useRealGh: true, cwd: checkout, ghEnv });
      let error: unknown;
      try {
        await startWorkflow({ issue: 59, cwd: checkout, backend: createFakeBackend() }, ctx);
      } catch (caught) {
        error = caught;
      }
      // The workflow is blocked with the reason — it is not a workflow that
      // runs, and it did not create anything.
      const [id] = await listWorkflows();
      expect((await loadWorkflow(id)).state).toBe('blocked');
      return { orca, error };
    }

    it('does not create a worktree when the CLI answers with a failure', async () => {
      const { orca, error } = await startWithGh('echo "no such issue" >&2; exit 1');

      expect(String((error as Error)?.message ?? error)).toContain('Cannot read the issue #59');
      expect(orca.created).toHaveLength(0);
      expect(orca.runs).toHaveLength(0);
      expect(orca.started).toHaveLength(0);
    });

    it('does not create a worktree when the CLI answers with no JSON', async () => {
      const { orca, error } = await startWithGh('echo "not json at all"');

      expect(String((error as Error)?.message ?? error)).toContain('answered with no JSON');
      expect(orca.created).toHaveLength(0);
      expect(orca.runs).toHaveLength(0);
      expect(orca.started).toHaveLength(0);
    });

    it('does not create a worktree when the CLI answers with another Issue', async () => {
      const { orca, error } = await startWithGh(
        `echo '{"number":60,"url":"https://github.com/gazon1/10x-chat/issues/60","title":"Another","body":"Another body."}'`,
      );

      expect(String((error as Error)?.message ?? error)).toContain('the issue #60');
      expect(orca.created).toHaveLength(0);
      expect(orca.runs).toHaveLength(0);
      expect(orca.started).toHaveLength(0);
    });

    it('does not create a worktree when the CLI answers with an Issue without a body', async () => {
      const { orca, error } = await startWithGh(
        `echo '{"number":59,"url":"https://github.com/gazon1/10x-chat/issues/59","title":"The issue of the workflow"}'`,
      );

      expect(String((error as Error)?.message ?? error)).toContain('no title or no body');
      expect(orca.created).toHaveLength(0);
      expect(orca.runs).toHaveLength(0);
      expect(orca.started).toHaveLength(0);
    });
  });

  it('does not start an agent in a workflow that is being stopped', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const record = aRecord('issue-59-cccccccc', 'worktree-created');
    orca.worktrees = [anOrcaWorktree()];
    // The Run is there already — the workflow goes straight to the agent.
    record.orca = { repoId: 'repo-1', runId: 'run-1' };
    await saveWorkflow(record);

    // Another process stops the workflow while the agent is about to start: the
    // record on the disk says 'stopping' before the agent is started.
    const file = path.join(getWorkflowDir(record.id), 'workflow.json');
    const stopping = { ...record, state: 'stopping', revision: 1 };
    let ticks = 0;
    const ctx = contextOf(orca, git, {
      waitTimeoutMs: 20,
      now: () => {
        const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ticks++));
        if (ticks === 1) writeFileSync(file, `${JSON.stringify(stopping, null, 2)}\n`);
        return date;
      },
    });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(
      /no agent is started in a stopped workflow/,
    );

    // No agent was started in the workflow that is on its way out.
    expect(orca.started).toHaveLength(0);
  });

  it('stops the agent that was started while the workflow was stopped', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const record = aRecord('issue-59-dddddddd', 'worktree-created');
    orca.worktrees = [anOrcaWorktree()];
    record.orca = { repoId: 'repo-1', runId: 'run-1' };
    await saveWorkflow(record);

    // The stop of the other process lands while the agent starts: the agent is
    // there, and the workflow is on its way out.
    const file = path.join(getWorkflowDir(record.id), 'workflow.json');
    const stopping = { ...record, state: 'stopping', revision: 1 };
    orca.onWorkerStart = () => {
      writeFileSync(file, `${JSON.stringify(stopping, null, 2)}\n`);
    };
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/was stopped again/);

    // The agent that was started is stopped again — it does not work in a
    // workflow that is cancelled.
    expect(orca.started).toHaveLength(1);
    expect(orca.stopped).toContain('dispatch-1');
  });

  it('stops the agent of a lost answer when the workflow was stopped', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const record = aRecord('issue-59-eeeeeeee', 'worktree-created');
    orca.worktrees = [anOrcaWorktree()];
    record.orca = { repoId: 'repo-1', runId: 'run-1' };
    await saveWorkflow(record);

    // The answer of the start command is lost — the worker is there all the
    // same, and the stop of the other process does not see it.
    orca.workerStartError = new Error('the answer of the workerStart was lost');
    orca.lostWorker = { dispatchId: 'dispatch-9', taskId: 'task-9', state: 'working' };
    const file = path.join(getWorkflowDir(record.id), 'workflow.json');
    const stopping = { ...record, state: 'stopping', revision: 1 };
    let lists = 0;
    orca.workerList = async () => {
      lists += 1;
      // The second listing is the one of the lost answer: the stop of the
      // other process lands right there.
      if (lists === 2) writeFileSync(file, `${JSON.stringify(stopping, null, 2)}\n`);
      return orca.workers;
    };
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/was stopped again/);

    // The agent of the lost answer is stopped again — it does not work in a
    // workflow that is on its way out.
    expect(orca.started).toHaveLength(1);
    expect(orca.stopped).toContain('dispatch-9');
  });

  it('does not replace a record that cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    // The record of the run is broken while the agent starts: a record that
    // cannot be read is not an empty store, and it is never overwritten.
    orca.onWorkerStart = async () => {
      const [id] = await listWorkflows();
      await writeFile(
        path.join(getWorkflowDir(id), 'workflow.json'),
        '{ this is not a record',
        'utf-8',
      );
    };
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/cannot be read/);

    // The broken record is still there — the evidence of the run is not lost.
    const [id] = await listWorkflows();
    const broken = await readFile(path.join(getWorkflowDir(id), 'workflow.json'), 'utf-8');
    expect(broken).toBe('{ this is not a record');
  });

  it('refuses a worktree that belongs to another repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    git.commonDirs['/wt/issue-59'] = '/other/.git';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/belongs to another repository/);

    // The agent never works in a checkout of another repository.
    expect(orca.started).toHaveLength(0);
  });

  it('refuses the checkout of the user as the worktree of the workflow', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktreePath = '/repo';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/the checkout of the repository/);

    expect(orca.started).toHaveLength(0);
  });

  it('refuses a worktree that works on another branch', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    git.branches['/wt/issue-59'] = 'main';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/works on the branch main/);

    expect(orca.started).toHaveLength(0);
  });

  it('refuses a worktree whose branch cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The branch of the worktree cannot be read — the workflow cannot prove
    // that the agent works on the branch of the Issue.
    git.branches['/wt/issue-59'] = '';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/branch of the worktree .* cannot be read/);

    expect(orca.started).toHaveLength(0);
  });

  it('refuses the registration of the repository on another host', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The same owner/name on another host is another repository: the agent
    // would work in a checkout that is not the repository of the Issue.
    orca.repos = [
      {
        id: 'repo-9',
        path: '/repo',
        displayName: '10x-chat',
        canonicalKey: 'git.example.com/gazon1/10x-chat',
      },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/registered in Orca for another host/);

    // No worktree of another repository is created.
    expect(orca.created).toHaveLength(0);
    expect(orca.started).toHaveLength(0);
  });

  it('adopts the Run of a lost answer of the runCreate', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    // The Run was created, but the answer never came.
    orca.runCreateError = new Error('the answer of the runCreate was lost');
    orca.runListEntries = [
      {
        id: 'run-9',
        objective: 'Issue #59 of gazon1/10x-chat: The issue of the workflow',
      },
    ];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The Run of the workflow is the one that is there — a second Run would be
    // a second home of the mailbox.
    expect(record.orca?.runId).toBe('run-9');
    expect(orca.runs).toHaveLength(1);
  });

  it('reports the lost answer of the runCreate when there is no Run', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.runCreateError = new Error('the answer of the runCreate was lost');
    orca.runListEntries = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/the answer of the runCreate was lost/);

    expect(orca.started).toHaveLength(0);
  });

  it('refuses to guess which Run of the same objective is its own', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The answer of the runCreate was lost and two Runs carry the objective:
    // the workflow does not adopt the first one of the listing.
    orca.runCreateError = new Error('the answer of the runCreate was lost');
    orca.runListEntries = [
      {
        id: 'run-8',
        objective: 'Issue #59 of gazon1/10x-chat: The issue of the workflow',
      },
      {
        id: 'run-9',
        objective: 'Issue #59 of gazon1/10x-chat: The issue of the workflow',
      },
    ];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/does not guess which one is its mailbox/);

    expect(orca.started).toHaveLength(0);
  });

  it('gives the agent the Issue, the rules of the work and the checks', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, {
      waitTimeoutMs: 20,
      requirements: async () => ({
        repository: 'gazon1/10x-chat',
        number: 59,
        url: 'https://github.com/gazon1/10x-chat/issues/59',
        title: 'The issue of the workflow',
        body: '## Acceptance criteria\n\n- the check of the change runs\n',
        hash: 'hash-of-the-issue',
        status: 'initial',
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
    });

    await startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx);

    const spec = orca.started[0]?.spec ?? '';
    // The Issue, its text and its acceptance criteria.
    expect(spec).toContain('Issue: #59');
    expect(spec).toContain('The issue of the workflow');
    expect(spec).toContain('## Acceptance criteria');
    expect(spec).toContain('- the check of the change runs');
    // The place of the work and the branch of it.
    expect(spec).toContain('/wt/issue-59');
    expect(spec).toContain('10x-chat/issue-59');
    // The instructions of the repository and the checks it defines.
    expect(spec).toContain('AGENTS.md');
    expect(spec).toContain('type check');
    expect(spec).toContain('lint');
    expect(spec).toContain('tests');
    // The worktree stays for a human.
    expect(spec).toContain('Never push');
  });

  it('gives the agent the instructions of the repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, {
      waitTimeoutMs: 20,
      readInstructions: async () => 'The conventions of the repository: two spaces, single quotes.',
    });

    await startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx);

    const spec = orca.started[0]?.spec ?? '';
    // The instructions are in the brief — the agent does not have to guess them.
    expect(spec).toContain('The instructions of the repository');
    expect(spec).toContain('The conventions of the repository: two spaces, single quotes.');
  });

  it('gives the agent of the corrections the instructions of the repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    let commits = 0;
    orca.onCheck = () => {
      git.head = `head-sha-${++commits}`;
    };
    const { review } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the change is wrong' },
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    const ctx = contextOf(orca, git, {
      review,
      waitTimeoutMs: 20,
      readInstructions: async () => 'The conventions of the repository: two spaces, single quotes.',
    });

    await startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx);

    // The corrections are a new worker — it gets the instructions too.
    expect(orca.started).toHaveLength(2);
    expect(orca.started[1]?.spec).toContain('The conventions of the repository');
  });

  it('never takes over a worktree with changes that are not committed', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.worktrees = [
      {
        id: 'wt-9',
        path: '/wt/issue-59',
        name: 'issue-59',
        branch: '10x-chat/issue-59',
      },
    ];
    // The worktree carries changes that nobody committed — the agent would
    // carry them into the change of the Issue.
    git.dirtyByPath['/wt/issue-59'] = [' M src/workflow/orchestrator.ts'];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/not committed/);

    expect(orca.started).toHaveLength(0);
    expect(orca.created).toHaveLength(0);
  });

  it('refuses a worktree that starts at another commit', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The worktree is at another commit than the one the workflow asked for.
    git.heads['/wt/issue-59'] = 'other-sha';
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/starts at other-/);

    // No agent works in a worktree of another commit.
    expect(orca.started).toHaveLength(0);
  });

  it('does not start a second agent when the agent of an interrupted start has finished', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    git.head = 'head-sha-1';
    orca.workerState = 'settled';
    orca.workerOutcome = 'succeeded';
    // The agent of the interrupted start has finished — the workflow does not
    // start a second one in the same worktree.
    orca.workers = [{ dispatchId: 'dispatch-9', taskId: 'task-9', state: 'settled' }];
    const { review, seen } = fakeReview(git, [
      { verdict: 'APPROVE', reason: 'the change is correct' },
    ]);
    const record = aRecord('issue-59-ffffffff', 'worktree-created');
    record.orca = { repoId: 'repo-1', runId: 'run-1' };
    orca.worktrees = [anOrcaWorktree()];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { review, waitTimeoutMs: 20 });

    const stored = await resumeWorkflow(record.id, ctx);

    // The worker that was there is the one the workflow waited for.
    expect(orca.started).toHaveLength(0);
    expect(stored.orca?.dispatchId).toBe('dispatch-9');
    expect(seen).toHaveLength(1);
  });

  it('blocks when the review judged another version of the requirements', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.onCheck = () => {
      git.head = 'head-sha-1';
    };
    const { review } = fakeReview(git, [
      {
        verdict: 'APPROVE',
        reason: 'the change is correct',
        requirementsHash: 'hash-of-the-read-requirements',
      },
    ]);
    const ctx = contextOf(orca, git, { review });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The version of the requirements that the review read is recorded — it
    // is the evidence of what the reviewers judged.
    expect(record.iterations[0]?.review?.requirementsHash).toBe('hash-of-the-read-requirements');
    // An approval of another version of the Issue is not an approval of this
    // change: the workflow does not complete.
    expect(record.state).toBe('blocked');
    expect(record.blocked).toMatch(/another version/);
  });

  it('needs the whole lifecycle of the orchestration, not a family of capabilities', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The runtime advertises the family of the orchestration but not the
    // operations of it.
    orca.capabilities = [
      'worktree.create-agent-options.v1',
      'orchestration.run-create',
      'orchestration.run-list',
      'orchestration.worker-start',
      'orchestration.worker-show',
      'orchestration.worker-list',
      'orchestration.worker-stop',
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/orchestration.check/);

    expect(orca.created).toHaveLength(0);
  });

  it('runs on a runtime that advertises every verb of the orchestration', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // No aggregate contract — every verb of the lifecycle is advertised.
    orca.capabilities = [
      'worktree.create-agent-options.v1',
      'orchestration.run-create',
      'orchestration.run-list',
      'orchestration.worker-start',
      'orchestration.worker-show',
      'orchestration.worker-list',
      'orchestration.worker-stop',
      'orchestration.check',
    ];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx);

    expect(orca.created).toHaveLength(1);
  });

  it('does not continue on a worktree that Orca does not have anymore', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-99999999', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    // The worktree of the record is not in Orca anymore.
    orca.worktrees = [];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/not in Orca anymore/);

    // No agent was started in a worktree the workflow does not own.
    expect(orca.started).toHaveLength(0);
  });

  it('does not continue on a worktree that Orca moved to another branch', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-88888888', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    orca.worktrees = [{ id: 'wt-1', path: '/wt/issue-59', branch: 'another-branch' }];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/another branch|is on the branch/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not continue on a worktree that Orca moved to another path', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-77777777', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    // The same worktree of Orca — but it is at another path now.
    orca.worktrees = [{ id: 'wt-1', path: '/wt/other', branch: '10x-chat/issue-59' }];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/is at \/wt\/other/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not continue on a worktree whose branch Orca does not name', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-66666666', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    // The branch of the worktree is not named: nothing proves that the agent
    // would work on the branch of the workflow.
    orca.worktrees = [{ id: 'wt-1', path: '/wt/issue-59' }];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/does not name the branch/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not continue on a worktree that belongs to another repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-55555555', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    orca.worktrees = [anOrcaWorktree()];
    // The checkout of the worktree belongs to another repository.
    git.repositories = { '/wt/issue-59': 'other/repo' };
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/belongs to the repository/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not continue on a worktree whose checkout belongs to another repository', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-44444444', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    orca.worktrees = [anOrcaWorktree()];
    // The common directory of the worktree is the one of another repository —
    // the worktree does not belong to the repository of the workflow.
    git.commonDirs = { '/wt/issue-59': '/elsewhere/.git' };
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/belongs to another repository/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not continue when the repository of the worktree cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-33333333', 'implementation-running');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    orca.worktrees = [anOrcaWorktree()];
    // The identity of the repository of the worktree is empty: nothing proves
    // that the agent works in the repository of the Issue.
    git.repositories = { '/wt/issue-59': '' };
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/cannot be read/);

    expect(orca.started).toHaveLength(0);
  });

  it('refuses to start a workflow when the store cannot be listed', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The store of the workflows is there, but its content cannot be read.
    const store = path.join(home, 'workflows');
    await mkdir(store, { recursive: true });
    await chmod(store, 0o300);
    const ctx = contextOf(orca, git);

    // A store that cannot be read may still hold a workflow of this Issue:
    // the start is refused instead of started next to it.
    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/cannot be listed/);

    expect(orca.created).toHaveLength(0);
  });

  it('refuses a runtime that names only one verb of the worktrees', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The runtime names a verb of the worktrees — and not the others. A
    // runtime that cannot create a worktree cannot run the workflow.
    orca.capabilities = ['orchestration.contract.v1', 'worktree.create'];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/worktree\.list/);

    expect(orca.created).toHaveLength(0);
  });

  it('refuses to start an agent when the instructions of the repository cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The AGENTS.md of the worktree is there and cannot be read: it is a
    // directory, not a file.
    const worktree = path.join(home, 'wt');
    await mkdir(path.join(worktree, 'AGENTS.md'), { recursive: true });
    const record = aRecord('issue-59-44444444', 'worktree-created');
    record.worktree = {
      id: 'wt-1',
      path: worktree,
      branch: '10x-chat/issue-59',
      baseRef: 'main',
      baseSha: 'base-sha',
    };
    record.orca = { repoId: 'repo-1', runId: 'run-1' };
    orca.worktrees = [{ id: 'wt-1', path: worktree, branch: '10x-chat/issue-59' }];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    // The rules of the repository are unknown — the agent is not started.
    await expect(resumeWorkflow(record.id, ctx)).rejects.toThrow(/instructions of the repository/);

    expect(orca.started).toHaveLength(0);
  });

  it('does not start two agents when two processes start the same Issue', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.messages = [];
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    const results = await Promise.allSettled([
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ]);

    // One of the two starts is refused — the Issue has one workflow.
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused.length).toBe(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(
      /already has a running workflow/,
    );
    expect(orca.started).toHaveLength(1);
  });

  it('does not accept the result of another worker of the Run', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The Run is reused between the iterations of the workflow: a message of
    // another worker is not the result of this one.
    orca.messages = [
      {
        type: 'worker_done',
        dispatchId: 'dispatch-other',
        outcome: 'succeeded',
        text: 'the work of another worker is done',
      },
    ];
    orca.workerState = 'settled';
    const ctx = contextOf(orca, git, { waitTimeoutMs: 100 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The result of another worker does not close this iteration.
    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('The state of the agent is unknown');
  });

  it('does not accept an ambiguous message of the Run', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The runtime names no Dispatch: the message belongs to the worker that
    // still works — and to nobody when the Run holds two of them.
    orca.nameTheDispatch = false;
    orca.workerState = 'settled';
    let commits = 0;
    orca.onCheck = () => {
      git.head = `head-sha-${++commits}`;
    };
    const { review } = fakeReview(git, [
      { verdict: 'REQUEST CHANGES', reason: 'the check does not run', findings: [aFinding()] },
    ]);
    const ctx = contextOf(orca, git, { review, waitTimeoutMs: 100 });

    const record = await startWorkflow(
      { issue: 59, cwd: '/repo', backend: createFakeBackend() },
      ctx,
    );

    // The second iteration shares its Run with the first one: the message of
    // the mailbox belongs to nobody that the workflow can prove.
    expect(record.iterations).toHaveLength(2);
    expect(record.state).toBe('blocked');
    expect(record.blocked).toContain('The state of the agent is unknown');
  });

  it('stops the worker of the Run of a workflow that is blocked already', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-blocked', 'blocked');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    // The agent of the workflow still works in the worktree.
    orca.workers = [{ dispatchId: 'dispatch-1', taskId: 'task-1', state: 'working' }];
    await saveWorkflow(record);
    const ctx = contextOf(orca, git);

    const stopped = await stopWorkflow(record.id, ctx);

    // The state of a workflow that is over does not move, and the agent that
    // still works in the worktree is stopped all the same.
    expect(stopped.state).toBe('blocked');
    expect(orca.stopped).toContain('dispatch-1');
  });

  it('does not claim that the workers of a blocked workflow are stopped when they are not', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    const record = aRecord('issue-59-blocked', 'blocked');
    record.orca = { repoId: 'repo-1', runId: 'run-1', dispatchId: 'dispatch-1' };
    orca.workers = [{ dispatchId: 'dispatch-1', taskId: 'task-1', state: 'working' }];
    orca.stopError = new Error('the runtime refused the stop');
    await saveWorkflow(record);
    const ctx = contextOf(orca, git);

    const stopped = await stopWorkflow(record.id, ctx);

    // The reason is in the record: a workflow that is blocked does not hide
    // the agent that still works in the worktree.
    expect(stopped.state).toBe('blocked');
    expect(stopped.blocked).toContain('could not be stopped');
  });

  it('refuses a runtime whose family of the worktrees does not promise their creation', async () => {
    const orca = new FakeOrca();
    // The family of the worktrees is a promise: it has to promise the
    // creation of a worktree, or the workflow cannot create one.
    orca.capabilities = ['orchestration.contract.v1', 'worktree.set.folder-parent.v1'];
    const ctx = contextOf(orca, new FakeGit());

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/worktree\.\*/);
  });

  it('refuses a runtime that does not support the operations of the worktrees', async () => {
    const orca = new FakeOrca();
    // The family of the features is not a proof of the operations: the
    // workflow proves them by calling them, before it creates anything.
    orca.worktreeListError = new Error('unknown command');
    const ctx = contextOf(orca, new FakeGit());

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/does not support the operations of the worktrees/);
  });

  it('refuses a worktree whose changes cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    // The changes of the worktree cannot be read: the workflow does not take
    // over a worktree whose changes it cannot see.
    git.dirty = async () => {
      throw new Error('git status failed');
    };
    orca.worktrees = [
      { id: 'wt-1', path: '/wt/issue-59', branch: '10x-chat/issue-59', name: 'issue-59' },
    ];
    const ctx = contextOf(orca, git);

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/cannot be read/);
  });

  it('reviews the change of the worktree with the real pipeline of the repository', async () => {
    // The real integration: the review of the workflow is the pipeline of the
    // repository, it reads the diff of a commit that was never pushed, and
    // the reviewers get it as it is.
    const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-review-'));
    const repo = path.join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    await gitIn(repo, 'init', '--initial-branch=main');
    await gitIn(repo, 'remote', 'add', 'origin', 'https://github.com/gazon1/10x-chat.git');
    await writeFile(path.join(repo, 'src.txt'), 'one\n', 'utf-8');
    await gitIn(repo, 'add', '.');
    await gitIn(repo, 'commit', '-m', 'first');
    const baseSha = await gitIn(repo, 'rev-parse', 'HEAD');
    // The worktree of the Issue is a worktree of the repository: the workflow
    // never works in the checkout of the user.
    const worktree = path.join(dir, 'worktree');
    await gitIn(repo, 'worktree', 'add', '-b', '10x-chat/issue-59', worktree);

    // The `gh` CLI of the PATH answers with the Issue: the workflow and the
    // pipeline read the same requirements.
    const bin = path.join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const issueFile = path.join(dir, 'issue.json');
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
      `#!/bin/sh\ncase "$1 $2" in\n"auth status") exit 0;;\n"issue view") cat "${issueFile}";;\nesac\n`,
      'utf-8',
    );
    await chmod(gh, 0o755);
    const pathBefore = process.env.PATH;
    process.env.PATH = `${bin}:${pathBefore ?? ''}`;

    try {
      const { backend, prompts } = recordingBackend();
      const orca = new FakeOrca();
      orca.worktreePath = worktree;
      orca.repos = [
        {
          id: 'repo-1',
          path: repo,
          displayName: '10x-chat',
          canonicalKey: 'github.com/gazon1/10x-chat',
        },
      ];
      // The agent of the workflow commits its change in the worktree.
      orca.onWorkerStart = async () => {
        await writeFile(path.join(worktree, 'src.txt'), 'one\ntwo\n', 'utf-8');
        await gitIn(worktree, 'add', '.');
        await gitIn(worktree, 'commit', '-m', 'second');
      };
      const ctx = createWorkflowContext({
        orca,
        backend,
        cwd: repo,
        git: nodeWorkflowGit,
        now: () => new Date(Date.UTC(2026, 0, 1)),
        waitTimeoutMs: 30_000,
      });

      const record = await startWorkflow({ issue: 59, cwd: repo, backend, baseRef: 'main' }, ctx);

      expect(record.state).toBe('completed');
      // The review compared the exact commits of the worktree.
      const headSha = await gitIn(worktree, 'rev-parse', 'HEAD');
      expect(record.iterations[0]?.review?.baseSha).toBe(baseSha);
      expect(record.iterations[0]?.review?.headSha).toBe(headSha);
      // The reviewers got the diff of the commit that was never pushed.
      expect(prompts[0]).toContain('+two');
      // The run of the review is written next to the record of the workflow:
      // it carries the diff of the change that was never pushed.
      const run = JSON.parse(
        await readFile(
          path.join(getWorkflowDir(record.id), 'reviews', 'iteration-1', 'review.json'),
          'utf-8',
        ),
      ) as { context: { diff: string; changedFiles: string[]; baseSha: string } };
      expect(run.context.changedFiles).toContain('src.txt');
      expect(run.context.diff).toContain('+two');
      expect(run.context.baseSha).toBe(baseSha);
      // The report of the review is written next to it.
      const report = await readFile(
        path.join(getWorkflowDir(record.id), 'reviews', 'iteration-1', 'report.md'),
        'utf-8',
      );
      expect(report).toContain('src.txt');
    } finally {
      process.env.PATH = pathBefore;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the lost answer of the runCreate when the Runs cannot be read', async () => {
    const orca = new FakeOrca();
    const git = new FakeGit();
    orca.runCreateError = new Error('the answer of the runCreate was lost');
    orca.runList = async () => {
      throw new Error('the Runs of Orca cannot be read');
    };
    const ctx = contextOf(orca, git, { waitTimeoutMs: 20 });

    await expect(
      startWorkflow({ issue: 59, cwd: '/repo', backend: createFakeBackend() }, ctx),
    ).rejects.toThrow(/the answer of the runCreate was lost/);

    // No agent works without a home of the mailbox.
    expect(orca.started).toHaveLength(0);
  });
});

describe('the store of the workflows', () => {
  const originalHome = process.env.TEN_X_CHAT_HOME;
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-workflow-'));
    process.env.TEN_X_CHAT_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.TEN_X_CHAT_HOME;
    else process.env.TEN_X_CHAT_HOME = originalHome;
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

  it('refuses to write the events of a workflow through a link', async () => {
    if (process.platform === 'win32') return;
    const record = aRecord();
    await saveWorkflow(record);
    const dir = getWorkflowDir(record.id);
    const file = path.join(dir, 'events.jsonl');
    const outside = path.join(home, 'outside.jsonl');
    await writeFile(outside, '', 'utf-8');
    await symlink(outside, file);

    // The history of a workflow is its evidence: a link would take the write
    // outside of the store.
    await expect(
      appendEvent(record.id, { at: '2026-01-01T00:00:00.000Z', state: 'created', detail: 'x' }),
    ).rejects.toThrow('symbolic link');
  });

  it('keeps the events of a workflow private', async () => {
    const record = aRecord();
    await saveWorkflow(record);
    await appendEvent(record.id, {
      at: '2026-01-01T00:00:00.000Z',
      state: 'created',
      detail: 'the workflow started',
    });

    const file = path.join(getWorkflowDir(record.id), 'events.jsonl');
    const info = await stat(file);
    // The history of the run belongs to the owner of the run alone.
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect(await readEvents(record.id)).toHaveLength(1);
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
