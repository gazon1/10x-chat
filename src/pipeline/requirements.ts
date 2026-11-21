import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from '../core/lock.js';
import { getRequirementsDir } from '../paths.js';
import type { IssueRequirements } from './types.js';

/**
 * The requirements of a review — the governing GitHub Issue and the version
 * of it that the review judges.
 *
 * The Issue is read through the `gh` CLI, hashed by its content and kept as a
 * small private snapshot: the next review of the same Issue compares its
 * version with the one of the last completed review, and the reviewers always
 * get the complete current description.
 */

/** The format of the stored snapshot — it changes when the format changes. */
const SNAPSHOT_VERSION = 1;

/**
 * The name of the lock of the snapshots — one lock for the whole directory.
 *
 * It is public: a test holds the lock of the store to prove that a second
 * process stays out of it while the first one is inside.
 */
export const REQUIREMENTS_LOCK = 'requirements.lock';

/** How long a run waits for the lock of the snapshots. */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * How long the `gh` CLI may take to answer.
 *
 * The CLI reads the Issue over the network: a run that waits for it forever
 * never produces a report, and a review without a report is nothing.
 */
const GH_TIMEOUT_MS = 60_000;

/** The Issue as `gh` answers it. */
export interface IssueData {
  number: number;
  url: string;
  title: string;
  body: string;
}

/** The snapshot of an Issue on the disk. */
interface StoredSnapshot {
  version: number;
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  hash: string;
  observedAt: string;
}

/**
 * The hash of the requirements — the version of the Issue.
 *
 * The hash covers the title and the body, and nothing else: the comments, the
 * labels and the milestones are not requirements, and the metadata of the
 * Issue can change without the requirements changing. The serialization is
 * unambiguous — an array of the two strings — so that two different Issues
 * cannot share a hash.
 */
export function hashRequirements(title: string, body: string): string {
  return createHash('sha256')
    .update(JSON.stringify([title, body]))
    .digest('hex');
}

/**
 * The Issue out of the answer of `gh`.
 *
 * The answer is data of another program: a value that is not an object, an
 * answer about another Issue and an answer without a title or a body are all
 * refused. A review that omits the requirements it was asked for is worse
 * than a review that fails.
 */
export function parseIssue(payload: unknown, expected: number): IssueData {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('gh answered with no issue');
  }
  const value = payload as Record<string, unknown>;
  const number = typeof value.number === 'number' ? value.number : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new Error('it has no number');
  }
  if (number !== expected) {
    throw new Error(`gh answered with the issue #${number}, not with the issue #${expected}`);
  }
  const title = typeof value.title === 'string' ? value.title : undefined;
  const body = typeof value.body === 'string' ? value.body : undefined;
  if (title === undefined || body === undefined) {
    throw new Error('it has no title or no body');
  }
  const url = typeof value.url === 'string' ? value.url : '';
  return { number, url, title, body };
}

/**
 * Run `gh` and capture what it says.
 *
 * The environment of the command is the environment of the process, unless the
 * caller names another one: the `gh` CLI of a different PATH is another CLI,
 * and a caller that needs a particular one has to be able to say so.
 */
export function runGh(
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        // A command that had to be killed answered nothing: it is a timeout,
        // and the reason says so — the run must not wait for it any longer.
        if (error && (error as { killed?: boolean }).killed) {
          resolve({
            stdout: '',
            stderr: `gh did not answer within ${Math.round(timeoutMs / 1000)}s`,
            code: 124,
          });
          return;
        }
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

/**
 * The Issue of the repository — the `gh` CLI is the only way to it.
 *
 * The repository is named: the Issue must belong to the repository of the
 * pull request, and a repository that is not named is a repository that is
 * not known.
 */
export async function fetchIssue(
  number: number,
  repository: string,
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<IssueData> {
  const result = await runGh(
    ['issue', 'view', String(number), '--repo', repository, '--json', 'number,url,title,body'],
    cwd,
    options.timeoutMs ?? GH_TIMEOUT_MS,
    { env: options.env },
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'gh is not available';
    throw new Error(`Cannot read the issue #${number}: ${reason}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Cannot read the issue #${number}: gh answered with no JSON.`);
  }
  try {
    return parseIssue(payload, number);
  } catch (error) {
    throw new Error(
      `Cannot read the issue #${number}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/** The repository of an Issue — `owner/name`, and nothing else. */
export function assertRepository(repository: string): void {
  const parts = repository.split('/');
  // A `.` or a `..` is a name of a directory, not a name of a repository: the
  // path of the snapshot is built from the two parts, and a `..` in one of them
  // would take the store of the snapshots out of the store.
  if (
    parts.length !== 2 ||
    parts.some((part) => part === '' || part === '.' || part === '..' || /\s/.test(part))
  ) {
    throw new Error(
      `The repository of the issue is unknown (${repository}) — the checkout must have an origin remote of the form owner/name.`,
    );
  }
}

/** A part of a path — a name of a directory that is safe to write. */
function safePart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The file of the snapshot of an Issue. */
function snapshotPath(repository: string, number: number): string {
  const [owner, name] = repository.split('/');
  const root = getRequirementsDir();
  const file = path.join(root, safePart(owner ?? ''), safePart(name ?? ''), `${number}.json`);
  // The path of the snapshot stays inside the store: the name of a repository
  // comes from the remote of the checkout, and a remote that names a directory
  // of the parent would read and write outside of the store.
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `The repository of the issue (${repository}) does not name a place in the store of the snapshots.`,
    );
  }
  return file;
}

/**
 * The store of the snapshots must hold ordinary files.
 *
 * The path of a snapshot is built from the repository and the number of the
 * Issue, and both `chmod()` and `readFile()` follow a link: a link in the store
 * would take the run outside of it and change the mode of a file that has
 * nothing to do with the requirements. A FIFO would block the run instead: the
 * read of a FIFO waits for a writer that never comes.
 */
async function refuseLinks(file: string): Promise<void> {
  const root = getRequirementsDir();
  const parts = path.relative(root, file).split(path.sep);
  let current = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part !== '') current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    // A part that is not there yet is a part that is still to be created.
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new Error(`the store of the requirements must not hold a symbolic link: ${current}`);
    }
    const last = index === parts.length;
    if (last ? !info.isFile() : !info.isDirectory()) {
      throw new Error(
        `the store of the requirements must hold ${last ? 'a file' : 'a directory'}: ${current}`,
      );
    }
  }
}

/**
 * The privacy of the store — the directories are private, the file is private.
 *
 * The mode is enforced before the read as well as before the write: a snapshot
 * that was restored with wide permissions, or a directory that another program
 * created, would show the description of the Issue to the other users of the
 * machine.
 */
async function enforcePrivacy(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(file);
  try {
    await chmod(getRequirementsDir(), 0o700);
    await chmod(path.dirname(dir), 0o700);
    await chmod(dir, 0o700);
    await chmod(file, 0o600);
  } catch (error) {
    // A store that is not there yet is a store that holds no snapshot: there is
    // nothing to keep private.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * The snapshot of the last completed review of an Issue.
 *
 * A file that is not there is no snapshot — the Issue is seen for the first
 * time. A file that is there and cannot be read is an error: a snapshot that
 * nobody can read is a baseline that nobody may advance, and the review says
 * so instead of pretending the Issue is new.
 */
export async function readBaseline(
  repository: string,
  number: number,
): Promise<StoredSnapshot | undefined> {
  const file = snapshotPath(repository, number);
  let content: string;
  try {
    await refuseLinks(file);
    await enforcePrivacy(file);
    // The file is opened without following a link and without waiting for a
    // writer: the store holds the snapshot of the Issue, and nothing else.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      content = await handle.readFile('utf-8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read the snapshot of the issue #${number}: ${String(error)}`);
  }
  try {
    const parsed = JSON.parse(content) as StoredSnapshot;
    // The whole snapshot is checked: a snapshot that lost a field is not a
    // snapshot, and a snapshot that is read as one would let a run advance a
    // baseline it cannot compare.
    if (
      parsed.version !== SNAPSHOT_VERSION ||
      typeof parsed.hash !== 'string' ||
      typeof parsed.observedAt !== 'string' ||
      typeof parsed.repository !== 'string' ||
      typeof parsed.number !== 'number' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.body !== 'string' ||
      typeof parsed.url !== 'string'
    ) {
      throw new Error('it has another format');
    }
    // The fields of the snapshot must agree with each other: a snapshot whose
    // hash does not belong to its title and its body describes no version of
    // an Issue, and a run that compared it with the current Issue would call a
    // changed Issue unchanged — the drift of the requirements would go
    // unnoticed, and the baseline of the run would be a lie.
    if (parsed.hash !== hashRequirements(parsed.title, parsed.body)) {
      throw new Error('its hash does not belong to its title and its body');
    }
    // The moment of the observation is compared as a text: a moment that is
    // not a timestamp cannot be ordered, and a snapshot that keeps itself
    // forever would freeze the baseline of the Issue. The canonical form is
    // the one of `toISOString()`: it is the only form in which the order of
    // the texts is the order of the moments.
    if (
      Number.isNaN(Date.parse(parsed.observedAt)) ||
      new Date(parsed.observedAt).toISOString() !== parsed.observedAt
    ) {
      throw new Error('its moment of observation is not a timestamp');
    }
    // The snapshot belongs to the Issue of the path it is stored at: a
    // snapshot of another Issue or of another repository is not the baseline
    // of this one.
    if (parsed.repository !== repository || parsed.number !== number) {
      throw new Error(`it is the snapshot of ${parsed.repository}#${parsed.number}`);
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `The snapshot of the issue #${number} cannot be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/**
 * The requirements of a review — the current Issue and its version.
 *
 * The Issue is read now, not remembered: the reviewers get the complete
 * current description, and the hash says whether it is the version of the
 * last completed review.
 */
export async function collectRequirements(
  number: number,
  repository: string,
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<IssueRequirements> {
  assertRepository(repository);
  const issue = await fetchIssue(number, repository, cwd, options);
  const hash = hashRequirements(issue.title, issue.body);
  const observedAt = new Date().toISOString();
  const baseline = await readBaseline(repository, number);
  const status = !baseline ? 'initial' : baseline.hash === hash ? 'unchanged' : 'changed';
  return {
    repository,
    number,
    url: issue.url,
    title: issue.title,
    body: issue.body,
    hash,
    status,
    observedAt,
    ...(baseline ? { previousHash: baseline.hash, previousTitle: baseline.title } : {}),
  };
}

/**
 * Whether the Issue is still the version the review judged.
 *
 * The Issue is read again after the reviewers ran: a requirement that changed
 * in the meantime is a requirement the review did not judge, and a review on
 * stale requirements is not an approval.
 */
export async function checkFreshness(
  requirements: IssueRequirements,
  cwd: string,
): Promise<{ fresh: boolean; detail: string }> {
  let issue: IssueData;
  try {
    issue = await fetchIssue(requirements.number, requirements.repository, cwd);
  } catch (error) {
    return {
      fresh: false,
      detail: `the issue #${requirements.number} could not be read again: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const hash = hashRequirements(issue.title, issue.body);
  if (hash !== requirements.hash) {
    return {
      fresh: false,
      detail:
        `the issue #${requirements.number} changed while the review was running — ` +
        `the review judged the version ${requirements.hash.slice(0, 12)}, the current version is ${hash.slice(0, 12)}`,
    };
  }
  return {
    fresh: true,
    detail: `the issue #${requirements.number} is still the version ${hash.slice(0, 12)}`,
  };
}

/**
 * Advance the baseline of an Issue — after a review that finished.
 *
 * The snapshot is written under the lock of the directory, and a snapshot
 * that was observed earlier than this one is kept: a run that is older must
 * not overwrite the requirements of a newer one.
 *
 * Two observations of the same millisecond cannot be ordered, and the stored
 * one is kept then: a tie must never let an observation that may be the older
 * one overwrite the requirements of the newer one.
 */
export async function advanceBaseline(
  requirements: IssueRequirements,
): Promise<{ advanced: boolean; detail: string }> {
  const dir = getRequirementsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  // The lock of the project is the lock of every store of the project: it is
  // an abstract unix socket, and the project runs on Linux only.
  const lock = await acquireLock(dir, REQUIREMENTS_LOCK, { timeoutMs: LOCK_TIMEOUT_MS });
  try {
    const stored = await readBaseline(requirements.repository, requirements.number);
    if (stored && stored.observedAt >= requirements.observedAt) {
      return {
        advanced: false,
        detail:
          stored.observedAt > requirements.observedAt
            ? `another review advanced the baseline of the issue #${requirements.number} — the newer version was kept`
            : `the baseline of the issue #${requirements.number} was observed in the same millisecond — the stored version was kept`,
      };
    }
    const file = snapshotPath(requirements.repository, requirements.number);
    // The store holds the snapshot of the Issue: a link in it would take the
    // write outside of the store.
    await refuseLinks(file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path.dirname(file), 0o700);
    await writeSnapshot(file, requirements);
    return {
      advanced: true,
      detail: `the baseline of the issue #${requirements.number} is the version ${requirements.hash.slice(0, 12)}`,
    };
  } finally {
    await lock?.release();
  }
}

/**
 * Write the snapshot — atomically, and readable by its owner only.
 *
 * The snapshot holds the requirements of a change: the file belongs to the
 * owner alone, the way the files of a run do (see `src/pipeline/review.ts`).
 */
async function writeSnapshot(file: string, requirements: IssueRequirements): Promise<void> {
  const snapshot: StoredSnapshot = {
    version: SNAPSHOT_VERSION,
    repository: requirements.repository,
    number: requirements.number,
    url: requirements.url,
    title: requirements.title,
    body: requirements.body,
    hash: requirements.hash,
    observedAt: requirements.observedAt,
  };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    // The mode of the file can be narrowed by the umask of the shell.
    if (process.platform !== 'win32') await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
