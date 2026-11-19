import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBackend } from '../src/backend/index.js';
import { collectReviewContext } from '../src/pipeline/context.js';
import { findingId } from '../src/pipeline/findings.js';
import { REVIEW_STEP_IDS, runReviewPipeline } from '../src/pipeline/review.js';
import type { ReviewContext } from '../src/pipeline/types.js';

const SOURCE = ['export function run(input: string) {', '  return exec(input);', '}'].join('\n');

let home: string;
let repo: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.TEN_X_CHAT_HOME;
  home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-review-'));
  process.env.TEN_X_CHAT_HOME = home;
  repo = await mkdtemp(path.join(os.tmpdir(), '10x-chat-review-repo-'));
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'app.ts'), SOURCE, 'utf-8');
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.TEN_X_CHAT_HOME;
  else process.env.TEN_X_CHAT_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

/** The context of a review over the temporary repository. */
function contextOf(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    repoRoot: repo,
    repository: 'owner/name',
    pr: 42,
    prUrl: 'https://github.com/owner/name/pull/42',
    title: 'Add the run function',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feature',
    headSha: 'b'.repeat(40),
    changedFiles: ['src/app.ts'],
    diff: '--- a/src/app.ts\n+++ b/src/app.ts\n+export function run() {}',
    diffTruncated: false,
    ...overrides,
  };
}

/** The finding the reviewers report — the same defect, seen twice. */
const FINDING = {
  title: 'Unchecked input reaches the sink',
  severity: 'BLOCKING',
  category: 'correctness',
  file: 'src/app.ts',
  line: 2,
  problem: 'The input of run() reaches exec() without a check.',
  impact: 'A caller with a hostile input executes an arbitrary command.',
  evidence: ['exec(input)'],
  fix: 'Validate the input before the call.',
};

/** The answer of a reviewer with one finding. */
function answerWith(findings: unknown[]): string {
  return JSON.stringify({ findings });
}

describe('the review pipeline', () => {
  it('runs against the fake backend and reports every step', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([FINDING]) },
      { prompt: '# Role: architecture', answer: answerWith([FINDING]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
      {
        prompt: '# Verification',
        answer: JSON.stringify({
          verdicts: [
            {
              id: findingId({ file: FINDING.file, line: FINDING.line, title: FINDING.title }),
              verdict: 'confirmed',
              evidence: 'exec(input) is called with the raw input',
            },
          ],
        }),
      },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    expect(run.steps.map((step) => step.id)).toEqual([...REVIEW_STEP_IDS]);
    expect(run.steps.every((step) => step.status === 'passed')).toBe(true);
    // The two reviewers that reported the same defect produced one finding.
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0].reportedBy).toEqual(['correctness', 'architecture']);
    expect(run.findings[0].verification).toBe('confirmed');
    expect(run.findings[0].evidence).toContain('exec(input) is called with the raw input');
  });

  it('writes the steps and the findings to the directory of the run', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([]) },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    const saved = JSON.parse(
      await readFile(path.join(home, 'reviews', run.id, 'review.json'), 'utf-8'),
    ) as { steps: { id: string }[]; findings: unknown[] };
    expect(saved.steps.map((step) => step.id)).toContain('verify-findings');
    expect(saved.findings).toEqual([]);
    const report = await readFile(path.join(home, 'reviews', run.id, 'report.md'), 'utf-8');
    expect(report).toContain('# PR review — Add the run function');
  });

  it('rejects a malformed answer instead of turning it into a finding', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: 'I found a bug in the input handling.' },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    const step = run.steps.find((candidate) => candidate.id === 'review-correctness');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toContain('no JSON payload');
    expect(run.findings).toHaveLength(0);
    expect(run.report).toContain('| review-correctness |');
  });

  it('marks an entry that does not pass the schema as invalid', async () => {
    const backend = createFakeBackend([
      {
        prompt: '# Role: correctness',
        answer: answerWith([{ title: 'A title', severity: 'BLOCKING' }]),
      },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    const step = run.steps.find((candidate) => candidate.id === 'review-correctness');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toContain('problem, impact missing');
    expect(run.findings).toHaveLength(0);
  });

  it('does not confirm a finding because the model says so', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([FINDING]) },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
      {
        prompt: '# Verification',
        // A verdict without evidence proves nothing.
        answer: JSON.stringify({
          verdicts: [
            {
              id: findingId({ file: FINDING.file, line: FINDING.line, title: FINDING.title }),
              verdict: 'confirmed',
              evidence: '',
            },
          ],
        }),
      },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    expect(run.findings[0].verification).toBe('unverified');
    expect(run.report).toContain('Unverified');
  });

  it('rejects a finding that points at a file which is not in the checkout', async () => {
    const ghost = { ...FINDING, file: 'src/ghost.ts', line: 3 };
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([ghost]) },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
      {
        prompt: '# Verification',
        answer: JSON.stringify({
          verdicts: [
            {
              id: findingId({ file: ghost.file, line: ghost.line, title: ghost.title }),
              verdict: 'confirmed',
              evidence: 'the file is not there',
            },
          ],
        }),
      },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    expect(run.findings[0].verification).toBe('rejected');
    expect(run.findings[0].verificationNote).toContain('not in the checkout');
  });

  it('keeps the evidence of a finding that the verification rejects', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([FINDING]) },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
      {
        prompt: '# Verification',
        answer: JSON.stringify({
          verdicts: [
            {
              id: findingId({ file: FINDING.file, line: FINDING.line, title: FINDING.title }),
              verdict: 'rejected',
              evidence: 'the sink validates the input itself',
            },
          ],
        }),
      },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => contextOf(),
    });

    expect(run.findings[0].verification).toBe('rejected');
    expect(run.findings[0].evidence).toContain('exec(input)');
    expect(run.findings[0].verificationNote).toContain('the sink validates the input itself');
  });

  it('reports a failed step instead of an empty review', async () => {
    const backend = createFakeBackend([
      { prompt: '# Role: correctness', answer: answerWith([]) },
      { prompt: '# Role: architecture', answer: answerWith([]) },
      { prompt: '# Role: tests', answer: answerWith([]) },
    ]);

    const run = await runReviewPipeline({
      backend,
      target: { cwd: repo },
      collect: async () => {
        throw new Error('no repository here');
      },
    });

    const step = run.steps.find((candidate) => candidate.id === 'collect-context');
    expect(step?.status).toBe('failed');
    expect(step?.detail).toContain('no repository here');
    expect(run.report).toContain('FAILED');
  });

  it('imports neither Playwright nor a provider module', async () => {
    const { readdir } = await import('node:fs/promises');
    const dir = path.join(process.cwd(), 'src', 'pipeline');
    const files = await readdir(dir);
    for (const file of files) {
      const content = await readFile(path.join(dir, file), 'utf-8');
      expect(content).not.toMatch(/from '.*playwright/);
      expect(content).not.toMatch(/from '.*\/providers\//);
      expect(content).not.toMatch(/from '.*\/browser\//);
    }
  });
});

describe('the context of a review', () => {
  it('collects the commits, the files and the diff of a branch', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), '10x-chat-review-git-'));
    try {
      const git = async (...args: string[]) => {
        const { execFile } = await import('node:child_process');
        return new Promise<void>((resolve, reject) => {
          execFile(
            'git',
            ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args],
            { cwd },
            (error) => (error ? reject(error) : resolve()),
          );
        });
      };
      await git('init', '--initial-branch=main');
      await writeFile(path.join(cwd, 'a.txt'), 'one\n', 'utf-8');
      await git('add', '.');
      await git('commit', '-m', 'first');
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(cwd, 'b.txt'), 'two\n', 'utf-8');
      await git('add', '.');
      await git('commit', '-m', 'second');

      const context = await collectReviewContext({ cwd, base: 'main', head: 'feature' });
      expect(context.baseRef).toBe('main');
      expect(context.headRef).toBe('feature');
      expect(context.baseSha).not.toBe(context.headSha);
      expect(context.changedFiles).toEqual(['b.txt']);
      expect(context.diff).toContain('b.txt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
