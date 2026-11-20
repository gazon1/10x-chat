import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { SECRET_EXCLUDES } from '../core/bundle.js';
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

/** Run a git command and keep its output as it is — nothing is trimmed. */
async function gitRaw(args: string[], cwd: string): Promise<string> {
  const result = await run('git', args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    );
  }
  return result.stdout;
}

/**
 * The names a git command prints — one name per name, as git names them.
 *
 * The command must be asked for `-z`: without it git quotes a name that holds
 * a backslash or a character outside of ASCII, and the quoted text is not the
 * name of the file.
 */
async function gitNames(args: string[], cwd: string): Promise<string[]> {
  const listed = await gitRaw(args, cwd);
  return listed.split('\0').filter((name) => name !== '');
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
  if (symbolic) return resolveBaseRef(cwd, symbolic.replace(/^origin\//, ''));
  const branches = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
    cwd,
  ).catch(() => '');
  // The short name of a remote branch carries the prefix of the remote:
  // `origin/main`, not `main`. The prefix is stripped before the names are
  // counted, and `HEAD` is not a branch. A branch name may contain a slash.
  const candidates = branches
    .split('\n')
    .map((branch) => branch.trim().replace(/^origin\//, ''))
    .filter((branch) => branch !== '' && branch !== 'HEAD');
  if (candidates.length === 1) return resolveBaseRef(cwd, candidates[0]);
  throw new Error(
    'Cannot resolve the default branch of origin — name the base explicitly (--base <ref>).',
  );
}

/**
 * The base of the comparison, as the repository knows it.
 *
 * The short name of a branch is not always a local branch: a clone that
 * fetched the remote only has `refs/remotes/origin/main`, and a `rev-parse`
 * of `main` fails there. The remote-tracking ref is the same commit and is
 * used when the local branch is absent.
 */
async function resolveBaseRef(cwd: string, name: string): Promise<string> {
  if (await resolvesToCommit(cwd, name)) return name;
  const remote = `origin/${name}`;
  if (await resolvesToCommit(cwd, remote)) return remote;
  return name;
}

/** Whether a ref names a commit of the repository. */
async function resolvesToCommit(cwd: string, ref: string): Promise<boolean> {
  const sha = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).catch(
    () => '',
  );
  return sha !== '';
}

/** The metadata of a pull request, as the pipeline reads it. */
export interface PullRequestMetadata {
  url: string;
  title?: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

/**
 * The metadata of a pull request out of the answer of `gh`.
 *
 * The commits are the point of the metadata: without them there is nothing to
 * compare, and a comparison of nothing looks like a change with no files.
 */
export function parsePullRequestMetadata(payload: unknown): PullRequestMetadata {
  // The answer of `gh` is data of another program: it may be anything at all.
  // A value that is not an object carries no commits, and it is refused the
  // same way a value without commits is.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('it has no base or head commit');
  }
  const value = payload as Record<string, unknown>;
  const baseRef = typeof value.baseRefName === 'string' ? value.baseRefName : '';
  const headRef = typeof value.headRefName === 'string' ? value.headRefName : '';
  const baseSha = typeof value.baseRefOid === 'string' ? value.baseRefOid : '';
  const headSha = typeof value.headRefOid === 'string' ? value.headRefOid : '';
  if (!baseSha || !headSha) {
    throw new Error('it has no base or head commit');
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

/** The metadata of a pull request — the `gh` CLI is the only way to it. */
async function pullRequestMetadata(pr: number, cwd: string): Promise<PullRequestMetadata> {
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
  try {
    return parsePullRequestMetadata(payload);
  } catch (error) {
    throw new Error(
      `Cannot read the pull request #${pr}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
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
    baseRef = target.base ? await resolveBaseRef(cwd, target.base) : await defaultBaseRef(cwd);
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
  // A file whose flag hides its modification from the status is not the file
  // of the revision: the bundle and the evidence are read from the disk.
  const hidden = await modifiedBehindTheFlag(repoRoot, headSha);
  if (hidden.length > 0) {
    throw new Error(
      `The checkout hides changes of ${hidden.join(', ')} behind a git flag (skip-worktree or assume-unchanged) — the review reads the files of the disk, and they must be the ones of the head.`,
    );
  }

  // The merge base is the real difference: a branch that lags behind its base
  // must not show the commits of the base as its own change. A diff that
  // cannot be computed is an error — an empty diff would be a review of
  // nothing that looks like a clean review.
  const range = `${baseSha}...${headSha}`;
  const changedFiles = await gitNames(['diff', '--name-only', '-z', range], cwd);

  // The files of the revision: the verification reads them, and a file that is
  // not committed must not be read at all.
  const tracked = await trackedFiles(repoRoot, headSha);

  // The files the change removes: they are gone from the head, but a finding
  // against them is a finding about the deletion, not about a missing file.
  const removed = await deletedFiles(repoRoot, baseSha, headSha);

  // The files that may hold a secret are never read: their content must not
  // reach the backend — neither in the diff of the change nor in the
  // evidence of a finding.
  //
  // The base counts too: a file that the change deletes is read from the
  // base revision, and a secret that the change deletes is a secret.
  const [readableHead, readableBase] = await Promise.all([
    readableFiles(repoRoot, headSha),
    readableFiles(repoRoot, baseSha),
  ]);
  const readable = new Set(readableHead);
  const readableOfBase = new Set(readableBase);
  const baseTracked = await trackedFiles(repoRoot, baseSha);
  const baseSecret = baseTracked.filter((file) => !readableOfBase.has(file));

  // A file that the change renames away from a name that may hold a secret
  // keeps the secret under its new name: the content of the old file is the
  // content of the new one, and the pathspec of the old name does not keep
  // it out of the diff.
  //
  // The rename detection of git is a similarity, and a file that was renamed
  // and rewritten is an addition and a deletion: the lines of the secret
  // decide then, and not the similarity.
  const changed = await changedNames(repoRoot, range);
  const inherited = [
    ...changed.renames.filter((pair) => baseSecret.includes(pair.from)).map((pair) => pair.to),
    ...(await carryingTheSecret(
      repoRoot,
      [
        // A secret of the base: the change may delete it and copy it.
        ...baseSecret.map((file) => ({ file, sha: baseSha })),
        // A secret that stays in the repository: the change may copy it under
        // a name of its own, and the name of the secret does not follow it.
        ...tracked.filter((file) => !readable.has(file)).map((file) => ({ file, sha: headSha })),
      ],
      [
        // A file that the change touches: its content is the content of the
        // head.
        ...changed.added.map((file) => ({ file, sha: headSha })),
        ...changed.modified.map((file) => ({ file, sha: headSha })),
        ...changed.renames.map((pair) => ({ file: pair.to, sha: headSha })),
        // A file that the change deletes: the diff of a deletion shows the
        // lines that are gone, and they are the lines of the base.
        ...changed.deleted.map((file) => ({ file, sha: baseSha })),
      ],
    )),
  ];

  const secretFiles = [
    ...new Set([...tracked.filter((file) => !readable.has(file)), ...baseSecret, ...inherited]),
  ];

  const diffOutput = await git(
    ['diff', range, '--', ':(top)**', ...secretPathspecs(), ...literalExcludes(inherited)],
    cwd,
  );
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
    trackedFiles: tracked,
    deletedFiles: removed,
    secretFiles,
    diff,
    diffTruncated,
  };
}

/**
 * The files of the bundle: the changed files, bounded.
 *
 * The diff already carries the change — the files are the context around it.
 *
 * The content of a file that may hold a secret is never in the bundle: the
 * name of such a file is in the changed files, but the file itself is not.
 */
export function contextFiles(context: ReviewContext): string[] {
  return context.changedFiles
    .filter((file) => !context.secretFiles.includes(file))
    .slice(0, MAX_CONTEXT_FILES);
}

/**
 * The patterns of the bundle.
 *
 * A name of a file is a name, not a pattern: `src/[id].ts` and a name that
 * starts with `!` would be read by the glob as something else entirely.
 */
export function bundlePatterns(files: string[]): string[] {
  return files.map((file) => `./${fg.escapePath(file)}`);
}

/**
 * The convention files of the repository — the ones that are there.
 *
 * The reviewers are told to read them; a backend that cannot browse the
 * repository must find them in the bundle.
 *
 * A convention file is a file of the revision under review: it is taken from
 * the commit, not from the disk. An untracked `AGENTS.md` of the checkout is
 * no convention of the repository — it is a file that nobody committed, and it
 * would steer the reviewers away from the change.
 */
export async function conventionFiles(repoRoot: string, headSha: string): Promise<string[]> {
  const names = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md'];
  const found: string[] = [];
  for (const name of names) {
    const listed = await git(
      ['ls-tree', '--name-only', headSha, '--', `:(literal)${name}`],
      repoRoot,
    ).catch(() => '');
    if (
      listed
        .split('\n')
        .map((line) => line.trim())
        .includes(name)
    ) {
      found.push(`./${name}`);
    }
  }
  return found;
}

/**
 * The pathspecs of the files that may hold a secret.
 *
 * The patterns are the patterns of the bundle — git reads them as a glob.
 */
function secretPathspecs(): string[] {
  return SECRET_EXCLUDES.map((pattern) => `:(exclude,glob)${pattern}`);
}

/** The empty tree — the tree of a commit without a parent. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The files of a revision whose content may be read — the tree of the
 * revision without the files that may hold a secret.
 *
 * The list comes from a diff against the empty tree: `git ls-tree` reads no
 * pathspec with magic, and the tree of the base must be listed the same way
 * as the tree of the head.
 */
async function readableFiles(repoRoot: string, sha: string): Promise<string[]> {
  return gitNames(
    ['diff', '--name-only', '-z', EMPTY_TREE, sha, '--', ':(top)**', ...secretPathspecs()],
    repoRoot,
  );
}

/**
 * The names the change touches — the renames and the added files.
 *
 * The pathspecs of the diff hide a renamed file: git reports the rename
 * under the new name, and the exclusion of the old name does not apply to
 * it. The rename is the one thing that says where the content came from.
 *
 * The similarity of the rename detection is low on purpose: a file that was
 * renamed and rewritten is still the file that was renamed.
 */
async function changedNames(
  repoRoot: string,
  range: string,
): Promise<{
  renames: { from: string; to: string }[];
  added: string[];
  modified: string[];
  deleted: string[];
}> {
  const listed = await gitRaw(['diff', '--name-status', '-M10%', '-z', range], repoRoot);
  const parts = listed.split('\0').filter((part) => part !== '');
  const renames: { from: string; to: string }[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const status = parts[index];
    const first = parts[index + 1];
    // A rename carries two names, every other change carries one.
    if (status.startsWith('R')) {
      const second = parts[index + 2];
      if (first && second) renames.push({ from: first, to: second });
      index += 3;
      continue;
    }
    if (status.startsWith('A') && first) added.push(first);
    // A type change (`T`) is a modification of its own: a symlink that becomes
    // a file of its own may carry a secret that the symlink pointed at.
    if ((status.startsWith('M') || status.startsWith('T')) && first) modified.push(first);
    // A deletion carries the content of the file as the base holds it: the
    // diff of a deletion shows the lines that are gone, and a secret among
    // them is shown to the backend.
    if (status.startsWith('D') && first) deleted.push(first);
    index += 2;
  }
  return { renames, added, modified, deleted };
}

/**
 * The files of the change that carry the content of a secret file.
 *
 * A secret may survive in a file the change touches: the rename detection of
 * git cannot see it when the content was rewritten, and the lines of the
 * secret decide then. A file that carries a line of a secret is a secret
 * under its new name too — and the secret may be one that the change does not
 * delete: a repository that keeps its `.env` may copy it into a file of its
 * own, and the name of the secret does not follow the content. A file that
 * was already there counts too: the copy of a secret hides as well in the
 * line that a change adds to a file of the repository.
 *
 * A file that the change deletes carries the secret too: the diff of a
 * deletion shows the lines that are gone, and the copy of a secret among
 * them would reach the backend.
 */
async function carryingTheSecret(
  repoRoot: string,
  secrets: { file: string; sha: string }[],
  touched: { file: string; sha: string }[],
): Promise<string[]> {
  if (secrets.length === 0 || touched.length === 0) return [];
  const exact = new Set<string>();
  const fragments: string[] = [];
  for (const secret of secrets) {
    for (const line of await meaningfulLines(repoRoot, secret.sha, secret.file)) {
      exact.add(line);
      // The copy of a secret hides in a line that says more than the secret:
      // the line itself, and the value it holds.
      if (line.length >= 8) fragments.push(line);
      fragments.push(...secretValues(line));
    }
  }
  if (exact.size === 0) return [];
  const carrying: string[] = [];
  for (const { file, sha } of touched) {
    for (const line of await meaningfulLines(repoRoot, sha, file)) {
      const holds = exact.has(line) || fragments.some((fragment) => line.includes(fragment));
      if (holds) {
        carrying.push(file);
        break;
      }
    }
  }
  return carrying;
}

/**
 * The values of a line of a secret.
 *
 * The value is the secret, the key is a name that the code of the repository
 * uses on purpose (`process.env.DATABASE_URL`). A value is looked for in the
 * files of the change when it is long enough to be distinctive (twelve
 * characters or more) or when it looks like a credential — six characters or
 * more, with a letter and a digit in it (`s3cr3t`). A short value of letters
 * only (`changeme`) is an ordinary word: many files of a repository hold it,
 * and withholding all of them would leave the review nothing to read.
 *
 * A secret is not always a line of `KEY=value`: a credential of a JSON file
 * is a pair of a key and a value, and the copy of it hides in a line of the
 * code that holds the value alone. The value of a pair is a value too.
 */
function secretValues(line: string): string[] {
  const values: string[] = [];
  const at = line.indexOf('=');
  if (at >= 0) {
    values.push(
      line
        .slice(at + 1)
        .trim()
        .replace(/^["']/, '')
        .replace(/["']$/, ''),
    );
  }
  for (const match of line.matchAll(/"[^"]*"\s*:\s*"([^"]*)"/g)) {
    values.push(match[1]);
  }
  return values.filter(distinctive);
}

/** A value that is worth looking for in the files of the change. */
function distinctive(value: string): boolean {
  if (value.length >= 12) return true;
  const long = value.length >= 6;
  const letter = /[A-Za-z]/.test(value);
  const digit = /[0-9]/.test(value);
  return long && letter && digit;
}

/**
 * The lines of a file in a revision — the ones that carry something.
 *
 * A line that is empty or that holds a single character says nothing, and
 * a file that shares such a line with a secret does not carry it.
 */
async function meaningfulLines(repoRoot: string, sha: string, file: string): Promise<Set<string>> {
  const content = await fileAtRevision(repoRoot, sha, file);
  if (content === undefined) return new Set();
  return new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 4),
  );
}

/**
 * The pathspecs that keep the given names out of the diff.
 *
 * The names are taken literally: a name of a file may hold a character that
 * a glob would read as something else.
 */
function literalExcludes(files: string[]): string[] {
  return files.map((file) => `:(exclude,literal)${file}`);
}

/**
 * The files whose content on the disk is not the content of the revision.
 *
 * A file marked with `skip-worktree` or `assume-unchanged` is not reported by
 * the status, so a change of it is invisible: the file is compared with the
 * commit of the revision, and a file that is not on the disk at all is no
 * file of the revision.
 *
 * A file that cannot be read is not a file of the revision either: the flag
 * hides its deletion from the status, and the review must not read a code
 * that the checkout does not have.
 */
async function modifiedBehindTheFlag(repoRoot: string, headSha: string): Promise<string[]> {
  const listed = await gitRaw(['ls-files', '-v', '-z'], repoRoot);
  const flagged = listed
    .split('\0')
    .filter((entry) => entry !== '')
    // The tag of a file that hides its modification: `S` is skip-worktree, a
    // lower case letter is assume-unchanged.
    .filter((entry) => entry[0] === 'S' || (entry[0] >= 'a' && entry[0] <= 'z'));
  const changed: string[] = [];
  for (const entry of flagged) {
    const file = entry.slice(2);
    const committed = await run('git', ['rev-parse', `${headSha}:${file}`], repoRoot);
    if (committed.code !== 0) {
      // The file is in the index but not in the revision: the checkout and
      // the revision are not the same thing.
      throw new Error(
        `The checkout has ${file}, which is not a file of the revision under review — the index and the head must be the same.`,
      );
    }
    const onDisk = await run('git', ['hash-object', '--path', file, '--', file], repoRoot);
    if (onDisk.code !== 0) {
      // The file cannot be hashed: it is either not on the disk at all — and
      // the flag hides its deletion — or it is not a file whose content is
      // read, a submodule or a directory.
      const there = await stat(path.join(repoRoot, file)).then(
        () => true,
        () => false,
      );
      if (!there) {
        throw new Error(
          `The checkout hides the deletion of ${file} behind a git flag (skip-worktree or assume-unchanged) — the review reads the files of the disk, and they must be the ones of the head.`,
        );
      }
      continue;
    }
    if (onDisk.stdout.trim() !== committed.stdout.trim()) changed.push(file);
  }
  return changed;
}

/**
 * The files of the revision — the paths, relative to the root of the repository.
 *
 * The list comes from the commit, not from the disk: a file that is not
 * committed (a secret, a key, a local scratch file) is not a file of the
 * revision and must not be read for a review.
 */
export async function trackedFiles(repoRoot: string, headSha: string): Promise<string[]> {
  return gitNames(['ls-tree', '-r', '--name-only', '-z', headSha], repoRoot);
}

/**
 * The files the change removes — the paths, relative to the root.
 *
 * A file that the change deletes is a file of the base revision: a finding
 * against it must be verified against the content it had before the deletion,
 * not rejected because it is gone from the head.
 *
 * The files are read from the two trees, not from the diff: a rename is a
 * removal of the old path too, and git reports it as a rename.
 */
export async function deletedFiles(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const [base, head] = await Promise.all([
    trackedFiles(repoRoot, baseSha),
    trackedFiles(repoRoot, headSha),
  ]);
  const inHead = new Set(head);
  return base.filter((file) => !inHead.has(file));
}

/**
 * The content of a file in a revision — `undefined` when it is not in it.
 *
 * The content comes from the commit, not from the disk: a deleted file is not
 * in the checkout any more, and the checkout is not the revision either.
 */
export async function fileAtRevision(
  repoRoot: string,
  sha: string,
  file: string,
): Promise<string | undefined> {
  const result = await run('git', ['show', `${sha}:${file}`], repoRoot);
  if (result.code !== 0) return undefined;
  return result.stdout;
}

/**
 * The path of a file as the repository names it — relative to the root, with
 * the `/` of the tree of Git.
 *
 * A backslash is a separator only on Windows: on POSIX it is a character of
 * the name of a file, and turning it into a slash renames the file.
 */
export function normalizeRepoPath(file: string): string {
  const unified = path.sep === '\\' ? file.replace(/\\/g, '/') : file;
  const normalized = path.posix.normalize(unified);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
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
  if (escapesRoot(relative)) return undefined;
  const realRoot = await realpath(repoRoot).catch(() => repoRoot);
  const realFile = await realpath(resolved).catch(() => undefined);
  if (!realFile) return undefined;
  const realRelative = path.relative(realRoot, realFile);
  if (escapesRoot(realRelative)) return undefined;
  return realFile;
}

/**
 * The entry of a file in a revision — whether it is a symlink, and where it
 * points at.
 *
 * The entry comes from the tree of Git: a symlink of a revision is a blob that
 * holds the path it points at, and that path belongs to the revision — the
 * link of the checkout may point elsewhere while the reviewers run.
 */
export async function revisionEntry(
  repoRoot: string,
  sha: string,
  file: string,
): Promise<{ symlink: boolean; target?: string } | undefined> {
  const listed = await git(['ls-tree', sha, '--', `:(literal)${file}`], repoRoot).catch(() => '');
  const entry = listed.split('\n').find((line) => line.includes('\t'));
  if (!entry) return undefined;
  const mode = entry.slice(0, entry.indexOf(' '));
  if (mode !== '120000') return { symlink: false };
  const blob = await fileAtRevision(repoRoot, sha, file);
  if (blob === undefined) return { symlink: true };
  // The blob of a symlink holds the path it points at, as it is: a target
  // with a newline in it is a name of its own, and trimming it would point
  // the link at a file that does not exist.
  return { symlink: true, target: blob };
}

/**
 * The file a symlink points at — the name of the file, relative to the root of
 * the repository.
 *
 * The target is joined the way the tree of Git joins it: the directory of the
 * link and the path of the target. A target that leaves the repository is no
 * file of it.
 */
export function symlinkTarget(link: string, target: string): string | undefined {
  if (!target || path.posix.isAbsolute(target)) return undefined;
  const directory = path.posix.dirname(link);
  const joined = directory === '.' ? target : `${directory}/${target}`;
  const normalized = path.posix.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

/**
 * The file of the revision that a name of the revision leads to — the name
 * itself, or the file behind a symlink.
 *
 * The links are followed in the revision, not on the disk: a symlink that
 * points at a file that was never committed leads to no file of the
 * revision, and a link that the checkout retargeted while the reviewers ran
 * still leads to the file of the revision.
 */
export async function fileBehindLink(
  repoRoot: string,
  sha: string,
  file: string,
  tracked: Set<string>,
): Promise<string | undefined> {
  let current = file;
  for (let step = 0; step < 16; step += 1) {
    if (!tracked.has(current)) return undefined;
    const entry = await revisionEntry(repoRoot, sha, current);
    if (!entry) return undefined;
    if (!entry.symlink) return current;
    if (entry.target === undefined) return undefined;
    const target = symlinkTarget(current, entry.target);
    if (!target) return undefined;
    current = target;
  }
  return undefined;
}

/**
 * Whether a relative path leaves the root of the repository.
 *
 * A name that starts with two dots is not a way out: `..config.ts` is a file of
 * the repository. Only a real step to the parent leaves it.
 */
function escapesRoot(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
