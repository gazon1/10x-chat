import type { ReviewVerdict, StepStatus } from '../pipeline/types.js';

/**
 * The model of a development workflow.
 *
 * A workflow is the state of one Issue on its way from an empty worktree to a
 * reviewed change: the worktree, the coding agent, the review and the fix
 * loop. The state is persisted after every transition, so that an
 * interrupted workflow can be inspected and resumed.
 */

/** The states of a workflow. */
export type WorkflowState =
  /** The workflow is recorded, nothing was read yet. */
  | 'created'
  /** The Issue and its requirements are read and persisted. */
  | 'issue-loaded'
  /** The worktree of the Issue exists. */
  | 'worktree-created'
  /** The coding agent works in the worktree. */
  | 'implementation-running'
  /** The agent is done — the change waits for its review. */
  | 'awaiting-review'
  /** The review of the change runs. */
  | 'review-running'
  /** The review asked for changes — the findings go back to the agent. */
  | 'fixes-requested'
  /** The workflow is being stopped — the workers are stopped first. */
  | 'stopping'
  /** Every gate passed. */
  | 'completed'
  /** The workflow cannot go on without a human. */
  | 'blocked'
  /** The workflow was stopped. */
  | 'cancelled';

/** The Issue of a workflow and the version of its requirements. */
export interface WorkflowIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  /** The SHA-256 of the title and the body — the version of the requirements. */
  hash: string;
  /** When this version was observed. */
  observedAt: string;
}

/** The worktree of a workflow. */
export interface WorkflowWorktree {
  /** The id of the worktree in Orca. */
  id: string;
  /** The path of the checkout — the only place the agent may work. */
  path: string;
  /** The branch of the worktree. */
  branch: string;
  /** The ref the worktree was created from. */
  baseRef: string;
  /** The commit the worktree started at. */
  baseSha: string;
}

/** The identifiers of the Orca objects a workflow owns. */
export interface WorkflowOrca {
  /** The id of the repository in Orca. */
  repoId: string;
  /** The id of the Run — the home of the mailbox of the workflow. */
  runId?: string;
  /** The id of the Task the worker settles. */
  taskId?: string;
  /** The id of the Dispatch — the handle of the worker. */
  dispatchId?: string;
}

/** A finding of the review of an iteration. */
export interface WorkflowFinding {
  id: string;
  severity: string;
  title: string;
  file?: string;
  line?: number;
  problem: string;
  impact: string;
  evidence: string[];
  fix?: string;
  /** Whether an independent pass confirmed, rejected or left the finding. */
  verification?: 'unverified' | 'confirmed' | 'rejected';
  /** Why the finding was confirmed or rejected. */
  verificationNote?: string;
}

/** The review of one iteration. */
export interface WorkflowReview {
  /** The id of the review run. */
  runId: string;
  verdict: ReviewVerdict;
  verdictReason: string;
  /** The commit the change starts at. */
  baseSha: string;
  /** The commit the change ends at. */
  headSha: string;
  /** The version of the requirements the review judged. */
  requirementsHash: string;
  /** The outcome of every step of the review. */
  steps: { id: string; status: StepStatus }[];
  /** The findings of the review. */
  findings: WorkflowFinding[];
  /** Where the report of the review is written. */
  reportPath?: string;
}

/** One round of implementation and review. */
export interface WorkflowIteration {
  /** The number of the iteration — it starts at 1. */
  index: number;
  startedAt: string;
  finishedAt?: string;
  /** What the agent reported — `succeeded`, `failed` or `unknown`. */
  agentOutcome?: 'succeeded' | 'failed' | 'unknown';
  /** The report of the agent. */
  agentReport?: string;
  /** The commit the iteration started at. */
  baseSha: string;
  /** The commit the iteration ended at. */
  headSha?: string;
  /**
   * The Dispatch of the worker of the iteration.
   *
   * It is the identity of the agent: an iteration that was started twice is
   * one iteration with one Dispatch, and the worker of the previous
   * iterations is not a candidate for the adoption of the next one.
   */
  dispatchId?: string;
  /** The review of the iteration. */
  review?: WorkflowReview;
}

/** The record of a workflow — the file on the disk. */
export interface WorkflowRecord {
  /** The version of the format of the record. */
  version: 1;
  /** The id of the workflow — the name of its directory. */
  id: string;
  /** The state of the workflow. */
  state: WorkflowState;
  /** The repository — `owner/name`. */
  repository: string;
  /** The Issue and the version of its requirements. */
  issue: WorkflowIssue;
  /** The worktree of the workflow. */
  worktree?: WorkflowWorktree;
  /** The identifiers of the Orca objects. */
  orca?: WorkflowOrca;
  /** The agent that implements the change. */
  agent: string;
  /** The ref the worktree is created from — the default branch of origin. */
  baseRef?: string;
  /** The backend that reviews the change. */
  backend: string;
  /**
   * The name of the backend — the way it is named on the command line.
   *
   * The label of the backend is for the report; the name is what a resume
   * needs: a workflow that was reviewed by one backend is resumed with the
   * same one, and never with another one behind the back of the user.
   */
  backendName?: string;
  /** The model the reviewers use. */
  model?: string;
  /** The maximum number of iterations — more of them block the workflow. */
  maxIterations: number;
  /** The iterations of the workflow. */
  iterations: WorkflowIteration[];
  /**
   * The number of the write of the record — the compare-and-swap of the state.
   *
   * Two processes that hold the same state are still two processes: the
   * revision tells whether the record on the disk is the one the process
   * holds, or whether somebody wrote it in the meantime.
   */
  revision?: number;
  /** Why the workflow is blocked, when it is. */
  blocked?: string;
  createdAt: string;
  updatedAt: string;
}

/** An event of the history of a workflow. */
export interface WorkflowEvent {
  /** When it happened. */
  at: string;
  /** The state the workflow was in. */
  state: WorkflowState;
  /** What happened. */
  detail: string;
}
