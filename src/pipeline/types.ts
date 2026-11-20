/**
 * The model of a review run.
 *
 * The types live here and not in the modules of the browser: the pipeline
 * knows a target, a backend and a set of findings — nothing else.
 */

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
  durationMs?: number;
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
}

/** The verdict of a review — the two the report format knows. */
export type ReviewVerdict = 'APPROVE' | 'REQUEST CHANGES';

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
  /** The verdict of the run — the machine-readable answer of the review. */
  verdict: ReviewVerdict;
  /** The reason of the verdict, in one sentence. */
  verdictReason: string;
  /** The report of the run, in the format of the repository. */
  report: string;
  startedAt: string;
  finishedAt: string;
}
