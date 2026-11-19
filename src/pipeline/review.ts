import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiBackend, BackendOutcome, BackendResponse } from '../backend/contract.js';
import { buildBundle } from '../core/bundle.js';
import { getReviewDir } from '../paths.js';
import {
  bundlePatterns,
  collectReviewContext,
  contextFiles,
  conventionFiles,
  resolveInRepo,
} from './context.js';
import { dedupeFindings, parseReviewerFindings, parseVerdicts } from './findings.js';
import { renderReviewReport } from './report.js';
import type {
  Finding,
  ReviewContext,
  ReviewRole,
  ReviewRun,
  ReviewTarget,
  StepOutcome,
} from './types.js';

/** The ids of the steps of the pipeline — they never change. */
export const REVIEW_STEP_IDS = [
  'collect-context',
  'build-bundle',
  'review-correctness',
  'review-architecture',
  'review-tests',
  'verify-findings',
  'normalize-findings',
  'render-report',
] as const;

/** What the pipeline needs to run a review. */
export interface ReviewPipelineOptions {
  /** The backend that answers — never a provider, never a browser. */
  backend: AiBackend;
  /** What is reviewed. */
  target: ReviewTarget;
  /**
   * The collector of the context.
   *
   * The default collects it from the repository; the tests collect their own,
   * so that the pipeline runs without a repository, a browser or credentials.
   */
  collect?: (target: ReviewTarget) => Promise<ReviewContext>;
  /** The model the reviewers use. */
  model?: string;
  /** The timeout of a request, in milliseconds. */
  timeoutMs?: number;
  /** The id of the run — the name of its directory. */
  runId?: string;
  /** The directory of the run — the default is the directory of the app. */
  runDir?: string;
  /** The label of the backend in the report. */
  backendLabel?: string;
}

/** The instructions of a reviewer role. */
const ROLE_PROMPTS: Record<ReviewRole, string> = {
  correctness: `# Role: correctness

You are an independent reviewer of a change. Your role: correctness, regressions, security and edge cases.

Look only for real defects: logic that is wrong, callers that break, data loss, security holes, missing error handling, unhandled boundary values, injection, authz, secrets, unsafe input and races.

Answer with JSON only, without prose around it:
{ "findings": [ { "title": "a short title", "severity": "BLOCKING|MAJOR|MINOR|INFO", "category": "correctness|security|architecture|maintainability|tests|compatibility|scope|other", "file": "path/of/the/file.ts", "line": 42, "problem": "one or two sentences", "impact": "the concrete failure scenario — inputs or state -> wrong result", "evidence": ["the code, the trace or the reproduction"], "fix": "the minimal correction" } ] }

If you find nothing blocking, return an empty array. Do not invent problems to fill the schema. Do not rewrite the code.`,
  architecture: `# Role: architecture

You are an independent reviewer of a change. Your role: architecture, maintainability, compatibility and scope discipline.

Judge the change against the conventions of the repository and against the code around it: does it fit the shape of the codebase, is it the smallest change that solves the task, does it break a public API, a format or a schema, does it leave dead code or needless abstraction, are the tests meaningful? Name the consequential decisions the requirements did not state and what they change.

Answer with JSON only, without prose around it:
{ "findings": [ { "title": "a short title", "severity": "BLOCKING|MAJOR|MINOR|INFO", "category": "correctness|security|architecture|maintainability|tests|compatibility|scope|other", "file": "path/of/the/file.ts", "line": 42, "problem": "one or two sentences", "impact": "the concrete failure scenario — inputs or state -> wrong result", "evidence": ["the code, the trace or the reproduction"], "fix": "the minimal correction" } ] }

If you find nothing blocking, return an empty array. Do not invent problems to fill the schema. Do not rewrite the code.`,
  tests: `# Role: tests

You are an independent reviewer of a change. Your role: tests and verification.

Is the behaviour covered, are the assertions meaningful, would the test fail without the fix, are the edge cases of the change tested, is there a test that only proves the code runs? Point at the test that is missing and at the behaviour it would pin.

Answer with JSON only, without prose around it:
{ "findings": [ { "title": "a short title", "severity": "BLOCKING|MAJOR|MINOR|INFO", "category": "correctness|security|architecture|maintainability|tests|compatibility|scope|other", "file": "path/of/the/test.ts", "line": 42, "problem": "one or two sentences", "impact": "the concrete failure scenario — inputs or state -> wrong result", "evidence": ["the code, the trace or the reproduction"], "fix": "the minimal correction" } ] }

If the change is covered, return an empty array. Do not invent problems to fill the schema. Do not rewrite the code.`,
};

/** The instructions of the verification pass. */
const VERIFICATION_PROMPT = `# Verification

You are an independent verifier of the candidate findings of a code review. You did not write them and you must not assume they are true.

For every finding, check the claim against the source excerpt, the callers and the tests that are given to you. A finding is confirmed only when the excerpt and the callers show the failure scenario. Reject a finding whose scenario the code cannot reach. When the material does not settle the question, answer unverified — an unverified answer is a good answer.

Answer with JSON only, without prose around it:
{ "verdicts": [ { "id": "f-00000000", "verdict": "confirmed|rejected|unverified", "evidence": "the lines that show it", "note": "why" } ] }

Answer for every finding that is given to you.`;

/** The context of a review, as the reviewers see it. */
function contextBlock(context: ReviewContext): string {
  const target = context.pr
    ? `pull request #${context.pr}${context.prUrl ? ` — ${context.prUrl}` : ''}`
    : `branch ${context.headRef}`;
  const files = context.changedFiles.length > 0 ? context.changedFiles.join('\n') : '(none)';
  return `# Review context
Repository: ${context.repository}
Target: ${target}
Subject: ${context.title ?? '(none)'}
Base: ${context.baseRef} (${context.baseSha})
Head: ${context.headRef} (${context.headSha})
Changed files:
${files}

Conventions: read AGENTS.md, CONTRIBUTING.md and the README of the repository before you judge the change.

# Diff
\`\`\`diff
${context.diff}
\`\`\``;
}

/** The state of a step, with the time it took. */
function step(
  id: string,
  status: StepOutcome['status'],
  detail?: string,
  startedAt?: number,
): StepOutcome {
  return {
    id,
    status,
    ...(detail ? { detail } : {}),
    ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
  };
}

/** The excerpt of a file around a line — the lines with their numbers. */
async function excerptOf(
  repoRoot: string,
  finding: Finding,
): Promise<{ text: string; exists: boolean; lineInRange: boolean }> {
  if (!finding.file) return { text: '', exists: false, lineInRange: false };
  const resolved = await resolveInRepo(repoRoot, finding.file);
  if (!resolved) return { text: '', exists: false, lineInRange: false };
  let content: string;
  try {
    content = await readFile(resolved, 'utf-8');
  } catch {
    return { text: '', exists: false, lineInRange: false };
  }
  const lines = content.split('\n');
  const line = finding.line;
  const lineInRange = line === undefined || (line >= 1 && line <= lines.length);
  if (line === undefined) {
    return { text: lines.slice(0, 40).join('\n'), exists: true, lineInRange: true };
  }
  const from = Math.max(0, line - 16);
  const to = Math.min(lines.length, line + 15);
  const text = lines
    .slice(from, to)
    .map((contentLine, index) => `${from + index + 1}: ${contentLine}`)
    .join('\n');
  return { text, exists: true, lineInRange };
}

/** The files that mention a file — the callers of a change. */
async function callersOf(repoRoot: string, file: string): Promise<string[]> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'git',
      ['grep', '-l', '-F', '--', file],
      { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && line !== file)
            .slice(0, 20),
        );
      },
    );
  });
}

/** The verification material of a finding — the excerpt, the callers, the claim. */
async function verificationMaterial(
  repoRoot: string,
  finding: Finding,
): Promise<{ material: string; exists: boolean; lineInRange: boolean }> {
  const excerpt = await excerptOf(repoRoot, finding);
  const callers = finding.file ? await callersOf(repoRoot, finding.file) : [];
  const material = [
    `## ${finding.id} — ${finding.title}`,
    `Severity: ${finding.severity} | Category: ${finding.category}`,
    `Location: ${finding.file ?? '(none)'}${finding.line ? `:${finding.line}` : ''}`,
    `Claim: ${finding.problem}`,
    `Failure scenario: ${finding.impact}`,
    finding.evidence.length > 0 ? `Evidence of the reviewer: ${finding.evidence.join(' ')}` : '',
    `Excerpt of the source:`,
    '```',
    excerpt.text || '(the file could not be read)',
    '```',
    callers.length > 0
      ? `Files that mention it: ${callers.join(', ')}`
      : 'No other file mentions it.',
  ]
    .filter((part) => part !== '')
    .join('\n');
  return { material, exists: excerpt.exists, lineInRange: excerpt.lineInRange };
}

/**
 * Verify the candidate findings of a review.
 *
 * A finding is confirmed only when an independent pass confirms it with
 * evidence, and it is rejected when the material shows that its scenario
 * cannot happen. Everything else stays unverified — a model that answered
 * with valid JSON has proven nothing.
 */
async function verifyCandidates(options: {
  backend: AiBackend;
  runId: string;
  candidates: Finding[];
  repoRoot: string;
  model?: string;
  timeoutMs?: number;
}): Promise<{ findings: Finding[]; step: StepOutcome }> {
  const { backend, runId, candidates, repoRoot } = options;
  const startedAt = Date.now();
  const material: string[] = [];
  const mechanical = new Map<string, { exists: boolean; lineInRange: boolean }>();
  for (const finding of candidates) {
    const prepared = await verificationMaterial(repoRoot, finding);
    mechanical.set(finding.id, { exists: prepared.exists, lineInRange: prepared.lineInRange });
    material.push(prepared.material);
  }

  const request = {
    requestId: `${runId}-verify`,
    prompt: `${VERIFICATION_PROMPT}\n\n${material.join('\n\n')}`,
    ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  let outcome: Awaited<ReturnType<AiBackend['ask']>>;
  try {
    outcome = await backend.ask(request);
  } catch (error) {
    return {
      findings: candidates,
      step: step(
        'verify-findings',
        'failed',
        error instanceof Error ? error.message : String(error),
        startedAt,
      ),
    };
  }
  if (!outcome.ok) {
    return {
      findings: candidates,
      step: step(
        'verify-findings',
        'failed',
        `${outcome.failure.kind}: ${outcome.failure.message}`,
        startedAt,
      ),
    };
  }
  if (outcome.value.truncated) {
    return {
      findings: candidates,
      step: step('verify-findings', 'failed', 'the answer of the verifier was cut off', startedAt),
    };
  }

  const parsed = parseVerdicts(outcome.value.text);
  const verdicts = new Map(parsed.verdicts.map((verdict) => [verdict.id, verdict]));
  const findings = candidates.map((finding) => {
    const state = mechanical.get(finding.id);
    const verdict = verdicts.get(finding.id);
    // A finding that points at a file or a line that is not in the checkout
    // cannot be a defect of this change.
    if (finding.file && state && (!state.exists || !state.lineInRange)) {
      return {
        ...finding,
        verification: 'rejected' as const,
        verificationNote: state.exists
          ? 'the line is outside the file'
          : 'the file is not in the checkout',
      };
    }
    if (!verdict) return { ...finding, verification: 'unverified' as const };
    if (verdict.verdict === 'confirmed' && verdict.evidence.trim() !== '') {
      // A finding with no location is a hypothesis, not a defect: it cannot
      // be confirmed, whatever the verifier says.
      if (!finding.file) {
        return {
          ...finding,
          verification: 'unverified' as const,
          verificationNote: verdict.note ?? 'the finding points at no file',
        };
      }
      if (finding.line === undefined) {
        return {
          ...finding,
          verification: 'unverified' as const,
          verificationNote: verdict.note ?? 'the finding points at no line',
        };
      }
      return {
        ...finding,
        verification: 'confirmed' as const,
        verificationNote: verdict.note ?? verdict.evidence,
        evidence: [...new Set([...finding.evidence, verdict.evidence])],
      };
    }
    // A rejection without evidence is no rejection: a finding is not dropped
    // because a model said so.
    if (verdict.verdict === 'rejected' && verdict.evidence.trim() !== '') {
      return {
        ...finding,
        verification: 'rejected' as const,
        verificationNote: verdict.note ?? verdict.evidence,
      };
    }
    return {
      ...finding,
      verification: 'unverified' as const,
      ...(verdict.note ? { verificationNote: verdict.note } : {}),
    };
  });

  const confirmed = findings.filter((finding) => finding.verification === 'confirmed').length;
  // A verification that answered for nobody is not a verification that passed.
  const answered = candidates.filter((finding) => verdicts.has(finding.id)).length;
  const complete = parsed.invalid.length === 0 && answered === candidates.length;
  return {
    findings,
    step: step(
      'verify-findings',
      complete ? 'passed' : 'failed',
      `${candidates.length} candidates, ${confirmed} confirmed, ${answered} answered` +
        (parsed.invalid.length > 0 ? `, ${parsed.invalid.length} invalid verdicts` : '') +
        (complete ? '' : ' — the verification is incomplete'),
      startedAt,
    ),
  };
}

/**
 * Run a review pipeline.
 *
 * The pipeline knows the backend contract and the repository — no browser, no
 * provider, no selector. Every step has a stable id and its outcome is
 * reported, whether it passed or failed.
 */
export async function runReviewPipeline(options: ReviewPipelineOptions): Promise<ReviewRun> {
  const { backend, target } = options;
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const steps: StepOutcome[] = [];
  const collect = options.collect ?? collectReviewContext;

  // ── collect-context ───────────────────────────────────────────
  const collectStart = Date.now();
  let context: ReviewContext | undefined;
  try {
    context = await collect(target);
    steps.push(
      step(
        'collect-context',
        'passed',
        `${context.changedFiles.length} changed files, ${context.diff.length} characters of diff`,
        collectStart,
      ),
    );
  } catch (error) {
    steps.push(
      step(
        'collect-context',
        'failed',
        error instanceof Error ? error.message : String(error),
        collectStart,
      ),
    );
  }

  // ── build-bundle ──────────────────────────────────────────────
  let bundle = '';
  if (context) {
    const bundleStart = Date.now();
    const changed = bundlePatterns(contextFiles(context));
    const conventions = await conventionFiles(context.repoRoot, context.headSha);
    try {
      bundle = await buildBundle({
        prompt: contextBlock(context),
        files: [...changed, ...conventions],
        cwd: context.repoRoot,
      });
      const omitted = context.changedFiles.length - changed.length;
      steps.push(
        step(
          'build-bundle',
          'passed',
          `${changed.length} changed files and ${conventions.length} convention file(s) in the bundle${
            omitted > 0 ? `, ${omitted} omitted — the bound of the bundle` : ''
          }`,
          bundleStart,
        ),
      );
    } catch (error) {
      steps.push(
        step(
          'build-bundle',
          'failed',
          error instanceof Error ? error.message : String(error),
          bundleStart,
        ),
      );
    }
  } else {
    steps.push(step('build-bundle', 'skipped', 'no context to bundle'));
  }

  // ── the reviewer roles ────────────────────────────────────────
  const roles: ReviewRole[] = ['correctness', 'architecture', 'tests'];
  const candidates: Finding[] = [];
  for (const role of roles) {
    const roleStart = Date.now();
    if (!context || !bundle) {
      steps.push(step(`review-${role}`, 'skipped', 'no bundle to review'));
      continue;
    }
    const request = {
      requestId: `${runId}-${role}`,
      prompt: `${ROLE_PROMPTS[role]}\n\n${bundle}`,
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    let outcome: BackendOutcome<BackendResponse>;
    try {
      outcome = await backend.ask(request);
    } catch (error) {
      steps.push(
        step(
          `review-${role}`,
          'failed',
          error instanceof Error ? error.message : String(error),
          roleStart,
        ),
      );
      continue;
    }
    if (!outcome.ok) {
      steps.push(
        step(
          `review-${role}`,
          'failed',
          `${outcome.failure.kind}: ${outcome.failure.message}`,
          roleStart,
        ),
      );
      continue;
    }
    const text = outcome.value.text;
    if (text.trim() === '') {
      steps.push(step(`review-${role}`, 'failed', 'the reviewer answered with nothing', roleStart));
      continue;
    }
    // A cut off answer is not an answer: the findings it carries may be half
    // of the review.
    if (outcome.value.truncated) {
      steps.push(
        step(`review-${role}`, 'failed', 'the answer of the reviewer was cut off', roleStart),
      );
      continue;
    }
    const parsed = parseReviewerFindings(text, role);
    candidates.push(...parsed.findings);
    const invalid = parsed.invalid.length > 0 ? `, ${parsed.invalid.length} invalid` : '';
    steps.push(
      step(
        `review-${role}`,
        // An entry that did not pass the schema may be the defect that
        // matters: a reviewer that lost one is a reviewer that did not finish.
        parsed.invalid.length > 0 ? 'failed' : 'passed',
        `${parsed.findings.length} findings${invalid}${parsed.invalid.length > 0 ? ` — ${parsed.invalid.join('; ')}` : ''}`,
        roleStart,
      ),
    );
  }

  // ── verify-findings ───────────────────────────────────────────
  const unique = dedupeFindings(candidates);
  let findings = unique;
  if (unique.length === 0) {
    // Nothing to verify is a finished verification — the status 'skipped' is
    // for a step that could not run, and it makes the verdict incomplete.
    steps.push(step('verify-findings', 'passed', 'no candidate finding to verify'));
  } else {
    const verification = await verifyCandidates({
      backend,
      runId,
      candidates: unique,
      repoRoot: context?.repoRoot ?? '',
      ...(options.model ? { model: options.model } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    steps.push(verification.step);
    findings = dedupeFindings(verification.findings);
  }

  // ── normalize-findings ────────────────────────────────────────
  const normalizeStart = Date.now();
  steps.push(
    step(
      'normalize-findings',
      'passed',
      `${candidates.length} reported, ${findings.length} after the merge`,
      normalizeStart,
    ),
  );

  // ── render-report ─────────────────────────────────────────────
  const renderStart = Date.now();
  const run: ReviewRun = {
    id: runId,
    target,
    ...(context ? { context } : {}),
    steps,
    findings,
    report: '',
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  run.report = renderReviewReport(run, {
    backendLabel: options.backendLabel ?? backend.name,
  });
  steps.push(step('render-report', 'passed', 'the report of the run', renderStart));

  await persistRun(run, options.runDir ?? getReviewDir(runId));
  return run;
}

/**
 * Write the run to its directory: the steps and the findings as JSON, the
 * report as markdown.
 */
export async function persistRun(run: ReviewRun, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'review.json'),
    JSON.stringify({ ...run, report: undefined }, null, 2),
    'utf-8',
  );
  await writeFile(path.join(dir, 'report.md'), run.report, 'utf-8');
}
