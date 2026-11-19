import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewContext, ReviewTarget } from './types.js';

/** The bound of the diff of the bundle — a bigger change is cut, not hidden. */
export const MAX_DIFF_CHARS = 120_000;

/** The bound of the files of the bundle. */
export const MAX_CONTEXT_FILES = 25;

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a command and capture what it says.
 *
 * A command that is not there fails like a command that failed — the caller
 * decides what that means.
 */
function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/** Run a git command — it fails loudly, with the message of git. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await run('git', args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    );
  }
  return result.stdout.trim();
}

/** The `owner/name` of a remote URL — the empty string when it has none. */
export function repositoryOf(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const url = ssh ? ssh[1] : trimmed.replace(/^[a-z+]+:\/\//, '').replace(/^[^/]+\//, '');
  const parts = url.split('/').filter((part) => part !== '');
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : '';
}

/**
 * The base of a comparison without a pull request.
 *
 * The default branch of `origin` is resolved, never assumed: a repository
 * whose default branch is not `main` must not be compared against `main`.
 */
async function defaultBaseRef(cwd: string): Promise<string> {
  const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(
    () => '',
  );
  if (symbolic) return symbolic.replace(/^origin\//, '');
  const branches = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
    cwd,
  ).catch(() => '');
  const candidates = branches
    .split('\n')
    .map((branch) => branch.trim())
    .filter((branch) => branch !== '' && !branch.includes('/'));
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    'Cannot resolve the default branch of origin — name the base explicitly (--base <ref>).',
  );
}

/** The metadata of a pull request — the `gh` CLI is the only way to it. */
async function pullRequestMetadata(
  pr: number,
  cwd: string,
): Promise<{
  url: string;
  title?: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}> {
  const result = await run(
    'gh',
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'number,url,title,baseRefName,baseRefOid,headRefName,headRefOid',
    ],
    cwd,
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'gh is not available';
    throw new Error(`Cannot read the pull request #${pr}: ${reason}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Cannot read the pull request #${pr}: gh answered with no JSON.`);
  }
  const value = payload as Record<string, unknown>;
  const baseRef = typeof value.baseRefName === 'string' ? value.baseRefName : '';
  const headRef = typeof value.headRefName === 'string' ? value.headRefName : '';
  const baseSha = typeof value.baseRefOid === 'string' ? value.baseRefOid : '';
  const headSha = typeof value.headRefOid === 'string' ? value.headRefOid : '';
  if (!baseSha || !headSha) {
    throw new Error(`Cannot read the pull request #${pr}: it has no base or head commit.`);
  }
  const title = typeof value.title === 'string' ? value.title : undefined;
  const url = typeof value.url === 'string' ? value.url : '';
  return {
    url,
    ...(title ? { title } : {}),
    baseRef,
    baseSha,
    headRef,
    headSha,
  };
}

/**
 * Collect the context of a review: the coordinates of the change and the
 * change itself.
 *
 * Nothing here touches a browser or a provider: the context comes from the
 * repository and, for a pull request, from the `gh` CLI.
 */
export async function collectReviewContext(target: ReviewTarget): Promise<ReviewContext> {
  const cwd = target.cwd;
  const repoRoot = await git(['rev-parse', '--show-toplevel'], cwd);
  const remoteUrl = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
  const repository = repositoryOf(remoteUrl) || repoRoot;

  let baseRef: string;
  let baseSha: string;
  let headRef: string;
  let headSha: string;
  let pr: number | undefined;
  let prUrl: string | undefined;
  let title: string | undefined;

  if (target.pr !== undefined) {
    const metadata = await pullRequestMetadata(target.pr, cwd);
    pr = target.pr;
    prUrl = metadata.url || undefined;
    title = metadata.title;
    baseRef = metadata.baseRef;
    baseSha = metadata.baseSha;
    headRef = metadata.headRef;
    headSha = metadata.headSha;
  } else {
    baseRef = target.base ?? (await defaultBaseRef(cwd));
    headRef = target.head ?? 'HEAD';
    baseSha = await git(['rev-parse', `${baseRef}^{commit}`], cwd);
    headSha = await git(['rev-parse', `${headRef}^{commit}`], cwd);
    title = await git(['log', '-1', '--format=%s', headSha], cwd).catch(() => '');
  }

  // The bundle and the evidence of the verification are read from the
  // checkout: the checkout must be the revision under review, or they are the
  // evidence of the wrong code.
  const checkoutSha = await git(['rev-parse', 'HEAD^{commit}'], cwd);
  if (checkoutSha !== headSha) {
    throw new Error(
      `The checkout is at ${checkoutSha.slice(0, 7)} but the review is of ${headSha.slice(0, 7)}` +
        ` — check out ${headRef} first (git checkout ${headRef}).`,
    );
  }
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (dirty !== '') {
    throw new Error(
      'The checkout has uncommitted changes — the review reads the files of the checkout, so they must be the ones of the head.',
    );
  }

  // The merge base is the real difference: a branch that lags behind its base
  // must not show the commits of the base as its own change. A diff that
  // cannot be computed is an error — an empty diff would be a review of
  // nothing that looks like a clean review.
  const range = `${baseSha}...${headSha}`;
  const files = await git(['diff', '--name-only', range], cwd);
  const changedFiles = files
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file !== '');

  const diffOutput = await git(['diff', range], cwd);
  const diffTruncated = diffOutput.length > MAX_DIFF_CHARS;
  const diff = diffTruncated
    ? `${diffOutput.slice(0, MAX_DIFF_CHARS)}\n\n[the diff was cut here — ${diffOutput.length - MAX_DIFF_CHARS} characters are missing]`
    : diffOutput;

  return {
    repoRoot,
    repository,
    ...(pr !== undefined ? { pr } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(title ? { title } : {}),
    baseRef,
    baseSha,
    headRef,
    headSha,
    changedFiles,
    diff,
    diffTruncated,
  };
}

/**
 * The files of the bundle: the changed files, bounded.
 *
 * The diff already carries the change — the files are the context around it.
 */
export function contextFiles(context: ReviewContext): string[] {
  return context.changedFiles.slice(0, MAX_CONTEXT_FILES);
}

/**
 * The path of a file of the repository — outside the root is refused.
 *
 * The real path decides, not the lexical one: a symlink inside the checkout
 * can point outside of it, and the file behind it is not a file of the
 * repository.
 */
export async function resolveInRepo(repoRoot: string, file: string): Promise<string | undefined> {
  const resolved = path.resolve(repoRoot, file);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const realRoot = await realpath(repoRoot).catch(() => repoRoot);
  const realFile = await realpath(resolved).catch(() => undefined);
  if (!realFile) return undefined;
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return undefined;
  return realFile;
}
