import type {
  DecisionKind,
  Finding,
  ReviewContext,
  ReviewImprovements,
  ReviewRun,
  ReviewVerdict,
  StepOutcome,
} from './types.js';

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
    case 'check-requirements':
      return 'gh issue view <number> --json number,url,title,body';
    case 'update-requirements':
      return 'writeSnapshot(requirements)';
    default:
      return '—';
  }
}

/**
 * The text of a reviewer, without the characters that drive a terminal.
 *
 * A reviewer is an untrusted source: its text may hold an ANSI escape
 * sequence, and a report that prints it moves the cursor of the reader and
 * hides the text behind it.
 */
function plain(value: string): string {
  const characters = [...value];
  const kept: string[] = [];
  let index = 0;
  while (index < characters.length) {
    const character = characters[index];
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      index = endOfSequence(characters, index + 1);
      continue;
    }
    // A control character, a line break and a tab excepted. The C1 range is
    // a control range too: its CSI and OSC introducers drive a terminal as
    // well.
    if (
      (code < 0x20 && code !== 0x0a && code !== 0x09) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      kept.push(' ');
      index += 1;
      continue;
    }
    kept.push(character);
    index += 1;
  }
  return kept.join('');
}

/**
 * The place where a control sequence ends — the character after it.
 *
 * A sequence is either a CSI (`ESC [ … final`) or an OSC (`ESC ] … BEL`).
 * Both are dropped as a whole: the text behind them is the text of the
 * reviewer, not a command of a terminal.
 */
function endOfSequence(characters: string[], start: number): number {
  const introducer = characters[start];
  if (introducer === '[') {
    let cursor = start + 1;
    while (cursor < characters.length) {
      const code = characters[cursor].codePointAt(0) ?? 0;
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      cursor += 1;
    }
    return cursor;
  }
  if (introducer === ']') {
    let cursor = start + 1;
    while (cursor < characters.length) {
      const code = characters[cursor].codePointAt(0) ?? 0;
      if (code === 0x07) return cursor + 1;
      if (code === 0x1b && characters[cursor + 1] === '\\') return cursor + 2;
      cursor += 1;
    }
    return cursor;
  }
  return start + 1;
}

/**
 * The text of a reviewer, without the markup of HTML.
 *
 * A reviewer is an untrusted source: the text of a finding may hold a tag,
 * and a report that is opened in a viewer that renders HTML shows the tag —
 * the markup of the reviewer becomes the markup of the report.
 */
function html(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The text of an untrusted source, as literal text of a Markdown report.
 *
 * A reviewer is an untrusted source: its text may hold the markup of
 * Markdown, and a report that is opened in a viewer renders it — a link or an
 * image of the reviewer becomes a link or an image of the report, and a line
 * break of the reviewer becomes a line of the report. A bare URL is a link
 * of the report as well, and the scheme of it is escaped for the same
 * reason: the link of a reviewer never becomes a link of the report.
 */
function literal(value: string): string {
  return html(plain(value))
    .replace(/([\\`*_[\]!|~])/g, '\\$1')
    .replace(/\b(https?|ftp|mailto):/gi, '$1\\:')
    .replace(/\b(www)\./gi, '$1\\.')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** A cell of a table — a pipe or a newline would break the table. */
function cell(value: string): string {
  // A backslash is escaped before a pipe: the escape of a pipe in a table
  // eats the backslash in front of it, and a name of a path has backslashes.
  return literal(value);
}

/**
 * The scope of the review — the files the change touches, by name.
 *
 * The format of the repository asks for the changed files of the scope, and a
 * reader of the report has to know what was judged: a count alone says that
 * something was reviewed, the names say what. The list is capped — a change of
 * a thousand files does not become a report of a thousand lines — and the rest
 * is counted.
 */
function scopeOf(context: ReviewContext | undefined): string {
  if (!context) return 'unknown — the context could not be collected';
  const files = context.changedFiles;
  if (files.length === 0) return 'no changed file — the change is empty';
  const shown = files.slice(0, 20).map((file) => literal(file));
  const rest = files.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  return `${files.length} changed file(s): ${list} — the diff and the changed files of the bundle`;
}

/**
 * The location of a finding — the file and the line, as it is.
 *
 * A name of a file may hold a pipe, a backtick or a backslash, and the table
 * of the report splits on a pipe: the location is written as inline HTML,
 * where a pipe is an entity and a backtick is an ordinary character, so the
 * name is shown exactly as it is.
 */
function locationOf(finding: Finding): string {
  if (!finding.file) return '—';
  const location = plain(`${finding.file}${finding.line ? `:${finding.line}` : ''}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/\r?\n/g, ' ');
  return `<code>${location}</code>`;
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

/** The label of a kind of decision — what kind of attention it needs. */
const KIND_LABEL: Record<DecisionKind, string> = {
  behavior_change: 'behavior change',
  intended: 'intended decision',
  implicit: 'implicit decision',
  assumption: 'unverified assumption',
};

/**
 * The implicit decisions of the run.
 *
 * A decision is the reading of the reviewers, not a verified fact: the report
 * says so, and the defects stay in the findings above. A decision that a
 * human has to confirm is the one the report puts first — it is the one that
 * waits for a person.
 */
function decisionsSection(run: ReviewRun): string[] {
  const lines: string[] = ['## Implicit decisions and trade-offs'];
  lines.push(
    'The reading of the reviewers: what the change decided where the requirements said nothing. A decision is not a defect — the proven defects are in the findings above.',
  );
  // A run of an older version has no decisions: the section says so instead of
  // failing.
  const decisions = [...(run.decisions ?? [])].sort(
    (a, b) => Number(b.needsHuman) - Number(a.needsHuman),
  );
  // The audit belongs to every role: a role that did not finish leaves the
  // audit unfinished, whatever the other roles reported.
  const unfinished = run.steps.filter(
    (candidate) => candidate.id.startsWith('review-') && candidate.status !== 'passed',
  );
  if (decisions.length === 0) {
    lines.push(
      unfinished.length > 0
        ? `- The audit is incomplete — ${unfinished.map((step) => `${step.id} (${step.status})`).join(', ')}.`
        : '- None reported — the reviewers named no decision of consequence (a trivial change may skip the audit).',
    );
    return lines;
  }
  if (unfinished.length > 0) {
    lines.push(
      `- The audit is incomplete — ${unfinished.map((step) => `${step.id} (${step.status})`).join(', ')}.`,
    );
  }
  decisions.forEach((decision, index) => {
    lines.push('');
    lines.push(
      `${index + 1}. **${literal(decision.decision)}** — ${KIND_LABEL[decision.kind]}` +
        ` (${decision.reportedBy.join(', ')})`,
    );
    for (const [label, value] of [
      ['Previous behavior or alternative', decision.previous],
      ['Evidence and rationale', decision.rationale],
      ['Consequence', decision.consequence],
      ['Failure scenario or unresolved risk', decision.risk],
    ] as const) {
      lines.push(`   - ${label}: ${literal(value)}`);
    }
    lines.push(`   - Human confirmation: ${decision.needsHuman ? 'needed' : 'not needed'}`);
  });
  return lines;
}

/**
 * The findings a role reported.
 *
 * The role is named even when its step failed: a reviewer that lost one entry
 * still reported the others, and the report must not hide them.
 */
function findingsOfRole(run: ReviewRun, role: string): Finding[] {
  return run.findings.filter((finding) => finding.reportedBy.includes(role as never));
}

/**
 * The verdict of the run.
 *
 * A grave finding asks for changes — and so does a grave finding that nobody
 * settled: an unverified `BLOCKING` or `MAJOR` is a hypothesis that may be the
 * defect that matters, and a review does not approve on the strength of a
 * guess. Only a rejected finding is settled and harmless. So does a review
 * that did not finish: a run whose reviewers all failed has found nothing, and
 * nothing is not an approval.
 */
export function verdictOf(run: ReviewRun): { verdict: ReviewVerdict; reason: string } {
  const grave = run.findings.filter(
    (finding) =>
      finding.verification !== 'rejected' &&
      (finding.severity === 'BLOCKING' || finding.severity === 'MAJOR'),
  );
  if (grave.length > 0) {
    const unsettled = grave.filter((finding) => finding.verification !== 'confirmed').length;
    return {
      verdict: 'REQUEST CHANGES',
      reason:
        `${grave.length} finding(s) of the severity BLOCKING or MAJOR` +
        (unsettled > 0 ? `, ${unsettled} of them not settled` : '') +
        '.',
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
  const verdict = run.verdict;
  const reason = run.verdictReason;

  const lines: string[] = [];
  lines.push(`# PR review — ${literal(subject)}`);
  lines.push('');
  lines.push(`- Repository: ${literal(context?.repository ?? 'unknown')}`);
  lines.push(`- Target: ${literal(target)}`);
  lines.push(
    context
      ? `- Base → Head: ${literal(context.baseRef)} (${context.baseSha}) → ${literal(context.headRef)} (${context.headSha})`
      : '- Base → Head: unknown — the context could not be collected',
  );
  lines.push(`- Reviewed at: ${run.finishedAt}`);
  // The version of the requirements: the Issue the reviewers judged, and the
  // version of it they judged.
  const requirements = context?.requirements;
  if (requirements) {
    const state =
      requirements.status === 'initial'
        ? 'the first version the pipeline has seen'
        : requirements.status === 'unchanged'
          ? 'unchanged since the last completed review'
          : `changed since the last completed review (was: ${requirements.previousTitle ?? 'unknown'})`;
    lines.push(
      `- Requirements: issue #${requirements.number} of ${literal(requirements.repository)} — ${literal(requirements.title)} — version ${requirements.hash.slice(0, 12)} (${state})`,
    );
  }
  lines.push(`- Scope: ${scopeOf(context)}`);
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

  lines.push(...decisionsSection(run));
  lines.push('');

  lines.push('## Acceptance criteria');
  lines.push('| Criterion | Status | Evidence |');
  lines.push('|---|---|---|');
  lines.push(
    requirements
      ? `| The acceptance criteria of the issue #${requirements.number} (version ${requirements.hash.slice(0, 12)}) | UNVERIFIED | The reviewers judged the change against the complete description of the Issue — the pipeline does not check the criteria one by one. |`
      : "| The acceptance criteria of the change | UNVERIFIED | The pipeline does not know them — they are the caller's. |",
  );
  lines.push('');

  lines.push('## Not verified');
  const notVerified = run.findings.filter((finding) => finding.verification === 'unverified');
  for (const finding of notVerified) {
    lines.push(
      `- ${literal(finding.title)} — ${literal(finding.verificationNote ?? 'the verification did not settle it')}`,
    );
  }
  for (const step of run.steps) {
    if (step.status === 'failed' || step.status === 'skipped') {
      lines.push(`- ${step.id} — ${literal(step.detail ?? step.status)}`);
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
  // Every finding that is still standing is a risk: a confirmed MAJOR is
  // open even though it is settled, and a rejected one is no risk at all.
  const risks = run.findings.filter((finding) => finding.verification !== 'rejected');
  if (risks.length === 0) {
    lines.push('- None — every finding was settled and none of them blocks the change.');
  } else {
    for (const finding of risks) {
      lines.push(
        `- ${literal(finding.title)} — ${finding.verification === 'unverified' ? 'not verified' : 'a confirmed defect'} (${finding.severity})`,
      );
    }
  }
  lines.push('');

  lines.push(...improvementsSection(run.improvements));

  return lines.join('\n');
}

/** The advisory follow-up improvements section of the report. */
function improvementsSection(improvements: ReviewImprovements | undefined): string[] {
  if (!improvements) return [];
  const lines: string[] = ['## Follow-up improvements'];
  if (improvements.status === 'completed') {
    if (improvements.detail) {
      lines.push(`Assessment: completed — ${literal(improvements.detail)}.`);
      lines.push('');
    }
    if (improvements.recommendations.length === 0) {
      lines.push('No follow-up improvements recommended.');
    } else {
      lines.push(
        '| # | Priority | Recommendation | Rationale | Evidence | Benefit | Scope | Existing solution | Separate Issue/PR |',
      );
      lines.push('|---|---|---|---|---|---|---|---|---|');
      improvements.recommendations.forEach((recommendation, index) => {
        lines.push(
          `| ${index + 1} | ${recommendation.priority} | ${cell(recommendation.title)} | ${cell(recommendation.rationale)} | ${cell(recommendation.evidence.join('; '))} | ${cell(recommendation.benefit)} | ${cell(recommendation.scope)} | ${cell(recommendation.existingSolution ?? '—')} | ${recommendation.separateWork ? 'Yes' : 'No'} |`,
        );
      });
      lines.push('');
      lines.push(
        'If you want to turn any of these into follow-up work, say which ones — no issue is created without your explicit approval.',
      );
    }
  } else {
    const state = improvements.status === 'failed' ? 'failed' : 'unavailable';
    lines.push(
      `The advisory assessment ${state}${improvements.detail ? `: ${literal(improvements.detail)}` : ''}.`,
    );
    lines.push('');
    lines.push('No follow-up improvements were produced. The review verdict is unchanged.');
  }
  lines.push('');
  return lines;
}
