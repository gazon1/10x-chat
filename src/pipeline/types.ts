/**
 * The model of a review run.
 *
 * The types live here and not in the modules of the browser: the pipeline
 * knows a target, a backend and a set of findings — nothing else.
 */

import type { BackendFailureKind, BackendSubmission } from '../backend/contract.js';

/** The severities of the report format of the repository. */
export type FindingSeverity = 'BLOCKING' | 'MAJOR' | 'MINOR' | 'INFO';

/**
 * The state of a finding.
 *
 * A finding is `unverified` until a verification pass has checked it against
 * the source: a model that produced valid JSON has not proven anything.
 */
export type FindingVerification = 'unverified' | 'confirmed' | 'rejected';

/** The categories a finding can carry. */
export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'architecture'
  | 'maintainability'
  | 'tests'
  | 'compatibility'
  | 'scope'
  | 'other';

/** The reviewer roles of the pipeline. */
export type ReviewRole = 'correctness' | 'architecture' | 'tests';

/**
 * The kinds of an implicit decision.
 *
 * A decision is not a defect: it is what the implementation chose where the
 * requirements said nothing. The kind says how much attention it needs — a
 * change of behavior is observed, an assumption is not.
 */
export type DecisionKind = 'behavior_change' | 'intended' | 'implicit' | 'assumption';

/**
 * An implicit decision of a change — what the implementation chose on its own.
 *
 * It is the reading of the reviewers, not a verified fact: a decision that is
 * also a defect is a finding, and a decision that names a risk is not one.
 */
export interface Decision {
  /** A stable id: the same decision keeps it across the roles. */
  id: string;
  /** The kind of the decision — what kind of attention it needs. */
  kind: DecisionKind;
  /** What was decided. */
  decision: string;
  /** The previous behavior or the alternative that was available. */
  previous: string;
  /** The evidence and the rationale of the decision. */
  rationale: string;
  /** What changes because of the decision. */
  consequence: string;
  /** The failure scenario or the unresolved risk. */
  risk: string;
  /** Whether a human has to confirm the decision. */
  needsHuman: boolean;
  /** The roles that reported the decision — more than one after a merge. */
  reportedBy: ReviewRole[];
}

/** A finding of a review. */
export interface Finding {
  /** A stable id: the same finding keeps it across runs and reviewers. */
  id: string;
  /** A short title — the one line of the finding. */
  title: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** The file of the finding, relative to the root of the repository. */
  file?: string;
  /** The first line of the finding, when it is anchored. */
  line?: number;
  /** The last line of the finding, when it spans more than one. */
  endLine?: number;
  /** What is wrong, in one or two sentences. */
  problem: string;
  /** The concrete failure scenario: which input or state produces what. */
  impact: string;
  /** The proof: the code, the trace, the reproduction. */
  evidence: string[];
  /** The minimal correction, when the reviewer names one. */
  fix?: string;
  /** Whether an independent pass confirmed, rejected or left the finding. */
  verification: FindingVerification;
  /** Why the finding was confirmed or rejected. */
  verificationNote?: string;
  /** The roles that reported the finding — more than one after a merge. */
  reportedBy: ReviewRole[];
}

/** The outcome of a step of the pipeline. */
export type StepStatus = 'passed' | 'failed' | 'skipped' | 'unavailable';

/** A step of the pipeline — the id is stable, the outcome is reported. */
export interface StepOutcome {
  id: string;
  status: StepStatus;
  /** What the step did, or why it failed. */
  detail?: string;
  /** The wall-clock duration of the step, in milliseconds. */
  durationMs?: number;
  /**
   * When the step started and when it ended, as ISO timestamps.
   *
   * The duration says how long, the bounds say when: a stage that waited for
   * the other stages is only visible with both.
   */
  startedAt?: string;
  finishedAt?: string;
  /**
   * The part of `durationMs` the step spent waiting for the backend to be
   * free, in milliseconds.
   *
   * Absent when the backend does not queue its requests, or when the stage
   * never reached the backend. `durationMs - queueWaitMs` is the time the
   * provider really worked on the request.
   */
  queueWaitMs?: number;
  /**
   * How many backend slots were active when the stage outcome was reported.
   *
   * Completion-time snapshot, not peak concurrency. Absent when the backend
   * does not report slot diagnostics.
   */
  activeSlots?: number;
  /**
   * Whether the failed request reached the model.
   *
   * It is what makes a failure actionable: `not_submitted` can be sent again,
   * `submitted` can only be resumed — sending it again would run it twice.
   */
  submission?: BackendSubmission;
  /** Why a failed stage failed — the kind of the backend failure. */
  failureKind?: BackendFailureKind;
  /**
   * The stage was omitted on purpose by the profile of the run.
   *
   * A `skipped` step is normally a step that could not run, and a run with one
   * is incomplete. The profile of a run may omit a stage by design — `quick`
   * runs one reviewer and no verification — and that is not a failure of the
   * run: it is the coverage its caller asked for. The flag keeps the two
   * apart, so a cheaper profile can be measured without being read as a broken
   * run. It never relaxes the gate: `quick` still cannot approve, because its
   * own coverage has no verification.
   */
  omittedByProfile?: boolean;
}

/** What answered a review run — the backend and the model of it. */
export interface ReviewBackend {
  /** The name of the backend — the key of the registry. */
  name: string;
  /** The provider underneath it, when the backend drives one. */
  provider?: string;
  /** The model the reviewers asked for, when one was named. */
  model?: string;
}

/**
 * The requirements of a review — the governing GitHub Issue.
 *
 * The snapshot is a version: the hash is the content of the Issue, and the
 * status says whether that content is the one of the last completed review.
 */
export interface IssueRequirements {
  /** The repository of the Issue — `owner/name`. */
  repository: string;
  /** The number of the Issue. */
  number: number;
  /** The URL of the Issue. */
  url: string;
  /** The title of the Issue. */
  title: string;
  /** The complete body of the Issue. */
  body: string;
  /** The SHA-256 of the title and the body — the version of the requirements. */
  hash: string;
  /**
   * How the version relates to the last completed review of the Issue:
   * `initial` — the Issue is seen for the first time, `unchanged` — the
   * requirements did not drift, `changed` — they did.
   */
  status: 'initial' | 'unchanged' | 'changed';
  /** When this version was observed — the order of two runs. */
  observedAt: string;
  /** The hash of the last completed review — absent when the Issue is new. */
  previousHash?: string;
  /** The title of the last completed review — absent when the Issue is new. */
  previousTitle?: string;
}

/** What is reviewed. */
export interface ReviewTarget {
  /** The directory of the repository. */
  cwd: string;
  /** The pull request to review — its metadata comes from `gh`. */
  pr?: number;
  /** The Issue that governs the change — its requirements come from `gh`. */
  issue?: number;
  /** The base of the comparison — the default branch of `origin` when absent. */
  base?: string;
  /** The head of the comparison — `HEAD` when absent. */
  head?: string;
  /**
   * The change is local: its head commit is not on `origin`.
   *
   * A change that was never pushed has no page on GitHub, so the reviewers
   * read its diff instead of a comparison that would show nothing. It is the
   * way a worktree of a workflow is reviewed before it is pushed.
   */
  local?: boolean;
}

/** The context of a review: the coordinates and the change itself. */
export interface ReviewContext {
  /** The root of the repository. */
  repoRoot: string;
  /** The repository — `owner/name` when it has a remote. */
  repository: string;
  /**
   * The web page of the repository — the reviewers read the change there.
   *
   * It is absent when the remote is not a URL (a local path): such a change
   * has no page, and the reviewers get its diff instead.
   */
  repositoryUrl?: string;
  /** The pull request under review, when the target is one. */
  pr?: number;
  /** The URL of the pull request. */
  prUrl?: string;
  /** The requirements of the change — the governing Issue, when there is one. */
  requirements?: IssueRequirements;
  /** The subject of the change. */
  title?: string;
  /** The base ref and its commit. */
  baseRef: string;
  baseSha: string;
  /** The head ref and its commit. */
  headRef: string;
  headSha: string;
  /** The files the change touches. */
  changedFiles: string[];
  /**
   * The files of the revision under review — the paths, relative to the root.
   *
   * A file that is not in this list is not a file of the change: the
   * verification must not read it, so that a local file that is not committed
   * (a secret, a key) never leaves the machine.
   */
  trackedFiles: string[];
  /**
   * The files the change removes — the paths, relative to the root.
   *
   * A file of this list is not in the head any more, but it is a file of the
   * change: a finding against it is verified against its content in the base
   * revision, not rejected because the file is gone.
   */
  deletedFiles: string[];
  /**
   * The files of the revision whose content is never read.
   *
   * A file of this list may hold a secret: its content reaches neither the
   * diff of the fallback nor the evidence of a finding.
   */
  secretFiles: string[];
  /**
   * The diff of the change, bounded.
   *
   * It is empty for a change that has a page on GitHub: the reviewers read it
   * there.
   */
  diff: string;
  /** Whether the diff was cut — the bound of the fallback. */
  diffTruncated: boolean;
  /**
   * The change is local — its head commit is not on `origin`.
   *
   * Such a change has no page on GitHub: the reviewers read the diff.
   */
  local?: boolean;
}

/** The verdict of a review — the two the report format knows. */
export type ReviewVerdict = 'APPROVE' | 'REQUEST CHANGES';

/**
 * The cost/coverage profile of a review.
 *
 * It selects which stages run and how strict the gate of the verdict is — it
 * never changes a stage. A run of an older version has none, and it is read as
 * `standard`: the full review it was.
 */
export type ReviewProfile = 'quick' | 'standard' | 'deep' | 'critical';

/** The priority of a follow-up improvement recommendation. */
export type ImprovementPriority = 'RECOMMENDED' | 'OPTIONAL';

/** A non-blocking follow-up improvement recommended after the review. */
export interface ReviewImprovement {
  /** A short title. */
  title: string;
  /** Why it is worth considering, grounded in the reviewed change. */
  rationale: string;
  /** Paths, symbols or finding IDs that support the recommendation. */
  evidence: string[];
  /** The expected benefit. */
  benefit: string;
  /** The suggested scope of the improvement. */
  scope: string;
  priority: ImprovementPriority;
  /** A maintained existing solution or library that could help, if any. */
  existingSolution?: string;
  /** Whether it should be a separate Issue/PR. */
  separateWork: boolean;
}

/** The advisory post-review assessment — separate from findings and steps. */
export interface ReviewImprovements {
  /** The outcome of the assessment. */
  status: 'completed' | 'unavailable' | 'failed';
  /** The recommendations — empty when there are none. */
  recommendations: ReviewImprovement[];
  /** Why the assessment could not be completed, when it could not. */
  detail?: string;
  /**
   * How long the assessment took, in milliseconds.
   *
   * It is not a step and never gates the verdict, but it is a request to the
   * backend like the others: without its duration the time of the run would
   * not be accounted for.
   */
  durationMs?: number;
  /** The part of that time the assessment waited for the backend to be free. */
  queueWaitMs?: number;
  /** Backend slots active while the assessment ran, when reported. */
  activeSlots?: number;
}

/** The result of a review run. */
export interface ReviewRun {
  /** The id of the run — the name of its directory. */
  id: string;
  /** The target of the run. */
  target: ReviewTarget;
  /** The context the run collected. */
  context?: ReviewContext;
  /** The outcome of every step, in the order of the pipeline. */
  steps: StepOutcome[];
  /** The findings of the run — normalized, deduplicated and verified. */
  findings: Finding[];
  /** The advisory post-review improvements — separate from findings and verdict. */
  improvements?: ReviewImprovements;
  /** The implicit decisions of the run — what the change decided on its own. */
  decisions: Decision[];
  /** The verdict of the run — the machine-readable answer of the review. */
  verdict: ReviewVerdict;
  /**
   * The profile the run selected.
   *
   * Additive: a run of an older version has none, and it is read as
   * `standard` — the full review, which is what it was.
   */
  profile?: ReviewProfile;
  /** The reason of the verdict, in one sentence. */
  verdictReason: string;
  /** The report of the run, in the format of the repository. */
  report: string;
  /**
   * What answered the run — the backend, its provider and the model.
   *
   * Additive: a run of an older version has none, and the report says so
   * instead of failing.
   */
  backend?: ReviewBackend;
  startedAt: string;
  finishedAt: string;
}
