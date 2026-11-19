import type { Finding, ReviewRun, StepOutcome } from './types.js';

/** What the report needs beyond the run itself. */
export interface ReportOptions {
  /** The label of the backend that answered — the provider of the run. */
  backendLabel?: string;
}

/** The result of a step in the wording of the report format. */
const RESULT_OF: Record<StepOutcome['status'], string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  skipped: 'SKIPPED',
  unavailable: 'UNAVAILABLE',
};

/** The command of a step — what the step did, in the wording of the format. */
function commandOf(step: StepOutcome, run: ReviewRun): string {
  const context = run.context;
  switch (step.id) {
    case 'collect-context':
      return context ? `git diff --name-only ${context.baseSha}...${context.headSha}` : '—';
    case 'build-bundle':
      return 'buildBundle(prompt, changed files)';
    case 'review-correctness':
    case 'review-architecture':
    case 'review-tests':
      return `backend.ask(${step.id.replace('review-', '')})`;
    case 'verify-findings':
      return 'backend.ask(verify)';
    case 'normalize-findings':
      return 'dedupeFindings(findings)';
    default:
      return '—';
  }
}

/** A cell of a table — a pipe or a newline would break the table. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** The location of a finding — the file and the line. */
function locationOf(finding: Finding): string {
  if (!finding.file) return '—';
  return `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\``;
}

/** The status of a finding in the wording of the report format. */
function statusOf(finding: Finding): string {
  switch (finding.verification) {
    case 'confirmed':
      return 'Open';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Unverified';
  }
}

/** The findings a role reported — the roles are the ones of the steps. */
function findingsOfRole(run: ReviewRun, role: string): Finding[] {
  const step = run.steps.find((candidate) => candidate.id === `review-${role}`);
  if (!step || step.status !== 'passed') return [];
  return run.findings.filter((finding) => finding.reportedBy.includes(role as never));
}

/**
 * The verdict of the run.
 *
 * A confirmed grave finding asks for changes — and so does a review that did
 * not finish: a run whose reviewers all failed has found nothing, and nothing
 * is not an approval.
 */
function verdictOf(run: ReviewRun): { verdict: string; reason: string } {
  const grave = run.findings.filter(
    (finding) =>
      finding.verification === 'confirmed' &&
      (finding.severity === 'BLOCKING' || finding.severity === 'MAJOR'),
  );
  if (grave.length > 0) {
    return {
      verdict: 'REQUEST CHANGES',
      reason: `${grave.length} confirmed finding(s) of the severity BLOCKING or MAJOR.`,
    };
  }
  const incomplete = run.steps.filter(
    (step) =>
      step.status === 'failed' || step.status === 'skipped' || step.status === 'unavailable',
  );
  if (incomplete.length > 0) {
    return {
      verdict: 'REQUEST CHANGES',
      reason: `the review is incomplete: ${incomplete.map((step) => step.id).join(', ')} did not pass.`,
    };
  }
  const confirmed = run.findings.filter((finding) => finding.verification === 'confirmed').length;
  const unverified = run.findings.filter((finding) => finding.verification === 'unverified').length;
  return {
    verdict: 'APPROVE',
    reason:
      `No confirmed finding of the severity BLOCKING or MAJOR` +
      (confirmed > 0 ? `, ${confirmed} confirmed finding(s) below the gate` : '') +
      (unverified > 0 ? `, ${unverified} unverified finding(s) below` : '') +
      '.',
  };
}

/**
 * The report of a run, in the format of the repository.
 *
 * The shape is the one of `skills/10x-chat/workflows/report-format.md`: the
 * same headings, the same tables, the same states. A reader of the old report
 * reads this one without a translation.
 */
export function renderReviewReport(run: ReviewRun, options: ReportOptions = {}): string {
  const context = run.context;
  const subject =
    context?.title ??
    (context?.pr ? `pull request #${context.pr}` : (context?.headRef ?? 'change'));
  const target = context?.pr
    ? `pull request #${context.pr}${context.prUrl ? ` — ${context.prUrl}` : ''}`
    : `branch ${context?.headRef ?? 'HEAD'}${context ? ` (${context.headSha.slice(0, 7)})` : ''}`;
  const provider = options.backendLabel ?? 'backend';
  const { verdict, reason } = verdictOf(run);

  const lines: string[] = [];
  lines.push(`# PR review — ${subject}`);
  lines.push('');
  lines.push(`- Repository: ${context?.repository ?? 'unknown'}`);
  lines.push(`- Target: ${target}`);
  lines.push(
    context
      ? `- Base → Head: ${context.baseRef} (${context.baseSha}) → ${context.headRef} (${context.headSha})`
      : '- Base → Head: unknown — the context could not be collected',
  );
  lines.push(`- Reviewed at: ${run.finishedAt}`);
  lines.push(
    `- Scope: ${context?.changedFiles.length ?? 0} changed file(s) — the diff and the changed files of the bundle`,
  );
  lines.push('');
  lines.push('## Verdict');
  lines.push(`${verdict} — ${reason}`);
  lines.push('');

  lines.push('## Checks');
  lines.push('| Check | Command | Result | Notes |');
  lines.push('|---|---|---|---|');
  for (const step of run.steps) {
    if (step.id === 'render-report') continue;
    lines.push(
      `| ${step.id} | \`${cell(commandOf(step, run))}\` | ${RESULT_OF[step.status]} | ${cell(step.detail ?? '')} |`,
    );
  }
  lines.push('');

  lines.push('## Findings');
  lines.push('| # | Severity | Location | Problem | Impact | Evidence | Status |');
  lines.push('|---|---|---|---|---|---|---|');
  if (run.findings.length === 0) {
    lines.push('| — | — | — | No finding survived the verification. | — | — | — |');
  } else {
    run.findings.forEach((finding, index) => {
      lines.push(
        `| ${index + 1} | ${finding.severity} | ${locationOf(finding)} | ${cell(finding.problem)} | ${cell(finding.impact)} | ${cell(finding.evidence.join(' '))} | ${statusOf(finding)} |`,
      );
    });
  }
  lines.push('');

  lines.push('## Acceptance criteria');
  lines.push('| Criterion | Status | Evidence |');
  lines.push('|---|---|---|');
  lines.push(
    "| The acceptance criteria of the change | UNVERIFIED | The pipeline does not know them — they are the caller's. |",
  );
  lines.push('');

  lines.push('## Not verified');
  const notVerified = run.findings.filter((finding) => finding.verification === 'unverified');
  for (const finding of notVerified) {
    lines.push(
      `- ${finding.title} — ${finding.verificationNote ?? 'the verification did not settle it'}`,
    );
  }
  for (const step of run.steps) {
    if (step.status === 'failed' || step.status === 'skipped') {
      lines.push(`- ${step.id} — ${step.detail ?? step.status}`);
    }
  }
  if (
    notVerified.length === 0 &&
    run.steps.every((s) => s.status !== 'failed' && s.status !== 'skipped')
  ) {
    lines.push('- Nothing — every step of the pipeline ran and every finding was settled.');
  }
  lines.push('');

  lines.push('## Reviewers');
  lines.push('| Role | Provider | Verdict | Notes |');
  lines.push('|---|---|---|---|');
  const roles: [string, string][] = [
    ['Correctness / security', 'correctness'],
    ['Architecture / scope', 'architecture'],
    ['Tests / verification', 'tests'],
  ];
  for (const [label, role] of roles) {
    const step = run.steps.find((candidate) => candidate.id === `review-${role}`);
    const findings = findingsOfRole(run, role);
    const verdictText =
      step?.status === 'failed'
        ? 'FAILED'
        : step?.status === 'skipped'
          ? 'SKIPPED'
          : findings.length > 0
            ? `${findings.length} finding(s)`
            : 'no findings';
    lines.push(`| ${label} | ${provider} | ${verdictText} | ${cell(step?.detail ?? '')} |`);
  }
  lines.push('');

  lines.push('## Remaining risks');
  const risks = run.findings.filter(
    (finding) => finding.verification === 'unverified' || finding.severity === 'BLOCKING',
  );
  if (risks.length === 0) {
    lines.push('- None — every finding was settled and none of them blocks the change.');
  } else {
    for (const finding of risks) {
      lines.push(
        `- ${finding.title} — ${finding.verification === 'unverified' ? 'not verified' : 'a confirmed defect'} (${finding.severity})`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
