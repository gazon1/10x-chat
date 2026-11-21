import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getWorkflowDir, getWorkflowsDir } from '../paths.js';
import type { WorkflowEvent, WorkflowRecord, WorkflowState } from './types.js';

/**
 * The store of the workflows.
 *
 * Every workflow is a directory of its own: the record of the workflow, the
 * history of its events, the review of every iteration and the report of the
 * whole run. The files belong to their owner alone and are written atomically:
 * a workflow that was interrupted must leave a readable record behind, never a
 * half-written one.
 */

/** The version of the format of the record. */
const RECORD_VERSION = 1;

/** The states a record may name. */
const STATES: WorkflowState[] = [
  'created',
  'issue-loaded',
  'worktree-created',
  'implementation-running',
  'awaiting-review',
  'review-running',
  'fixes-requested',
  'stopping',
  'completed',
  'blocked',
  'cancelled',
];

/**
 * The workflow is not there.
 *
 * A record that is not there and a record that cannot be read are two
 * different failures: the first one is a workflow that has not started, the
 * second one is a workflow whose evidence is broken. Only the first one may
 * be treated as an empty store.
 */
export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`Workflow not found: ${id}`);
    this.name = 'WorkflowNotFoundError';
  }
}

/** The file of the record of a workflow. */
function recordPath(id: string): string {
  return path.join(getWorkflowDir(id), 'workflow.json');
}

/** The file of the history of a workflow. */
function eventsPath(id: string): string {
  return path.join(getWorkflowDir(id), 'events.jsonl');
}

/** Write a file atomically — a temp file and a rename. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Make a directory private — the records of a workflow are its owner's. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

/**
 * Refuse a link in the store of the workflows.
 *
 * `chmod()` and `readFile()` follow a link: a link in the store would take the
 * read outside of it, into a file of somebody else.
 */
async function refuseLinks(file: string): Promise<void> {
  const root = getWorkflowsDir();
  const parts = path.relative(root, file).split(path.sep);
  let current = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part !== '') current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    // A part that is not there yet is a part that is still to be created.
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new Error(`the store of the workflows must not hold a symbolic link: ${current}`);
    }
    const last = index === parts.length;
    if (last ? !info.isFile() : !info.isDirectory()) {
      throw new Error(
        `the store of the workflows must hold ${last ? 'a file' : 'a directory'}: ${current}`,
      );
    }
  }
}

/**
 * Keep the directory of the store private — before every read of it.
 *
 * The names of the workflows are evidence too: a store that was restored with
 * wide permissions tells everybody which Issues were worked on, even when the
 * records inside of it are private. The directory is made private on the way
 * in, and a store that is not there yet holds nothing to keep private.
 */
async function enforceDirPrivacy(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const info = await lstat(dir);
    // The path is not a directory: there is nothing to keep private, and the
    // listing of it fails on its own.
    if (!info.isDirectory()) return;
    await chmod(dir, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Keep the store private — before every read, not only after every write.
 *
 * A store that was restored with wide permissions, or a record that was
 * replaced by hand, is a store that holds the evidence of a run for everybody:
 * the privacy of the store is enforced on the way in, not only on the way out.
 */
async function enforcePrivacy(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(file);
  try {
    await chmod(getWorkflowsDir(), 0o700);
    await chmod(path.dirname(dir), 0o700);
    await chmod(dir, 0o700);
    await chmod(file, 0o600);
  } catch (error) {
    // A store that is not there yet holds no record: there is nothing to keep
    // private.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Whether the value is a record of a workflow.
 *
 * The whole record is checked: a record that lost a field is not a record,
 * and a workflow that read one would move through states it never entered.
 */
function isWorkflowRecord(value: unknown): value is WorkflowRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<WorkflowRecord>;
  if (record.version !== RECORD_VERSION) return false;
  if (typeof record.id !== 'string' || record.id === '') return false;
  if (typeof record.state !== 'string' || !STATES.includes(record.state as WorkflowState)) {
    return false;
  }
  // The repository is unknown until the Issue is read: a workflow that was
  // interrupted before it holds no repository yet.
  if (typeof record.repository !== 'string') return false;
  if (record.state !== 'created' && record.repository === '') return false;
  if (typeof record.agent !== 'string' || typeof record.backend !== 'string') return false;
  if (typeof record.maxIterations !== 'number' || !Number.isFinite(record.maxIterations)) {
    return false;
  }
  if (!Array.isArray(record.iterations)) return false;
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    return false;
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    return false;
  }
  const issue = record.issue;
  if (typeof issue !== 'object' || issue === null) return false;
  if (typeof issue.number !== 'number' || typeof issue.hash !== 'string') return false;
  if (typeof issue.title !== 'string' || typeof issue.body !== 'string') return false;
  if (typeof issue.url !== 'string') return false;
  // A record that holds the version of the Issue was read from it, and the
  // identity it keeps is the whole of it: the number, the URL a human reads it
  // on, the title and the body. A workflow that failed before it managed to
  // read the Issue holds no version and no identity — it is blocked with the
  // reason, and there is nothing to name.
  if (issue.hash !== '' && issue.url === '') return false;
  return true;
}

/** Write the record of a workflow. */
export async function saveWorkflow(record: WorkflowRecord): Promise<void> {
  // A record is written only when it can be read back: a record that the
  // reader would refuse is evidence that nobody can inspect, and `status` would
  // report a broken workflow where a broken write happened.
  const written = { ...record, version: RECORD_VERSION };
  if (!isWorkflowRecord(written)) {
    throw new Error(
      `The workflow ${record.id} cannot be written: the record has another format (state '${record.state}', repository '${record.repository}').`,
    );
  }
  const dir = getWorkflowDir(record.id);
  // The links of the store are refused before the write: `mkdir()` and
  // `chmod()` follow a link, and a link in the store would take the record
  // outside of it.
  await refuseLinks(recordPath(record.id));
  await privateDir(getWorkflowsDir());
  await privateDir(dir);
  await writeAtomic(recordPath(record.id), `${JSON.stringify(written, null, 2)}\n`);
}

/** Read the record of a workflow. */
export async function loadWorkflow(id: string): Promise<WorkflowRecord> {
  const file = recordPath(id);
  let content: string;
  try {
    await refuseLinks(file);
    await enforcePrivacy(file);
    // The file is opened without following a link and without waiting for a
    // writer: the record belongs to its owner alone.
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkflowNotFoundError(id);
    }
    throw new Error(
      `Cannot read the workflow ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `The workflow ${id} is broken: its record cannot be parsed — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isWorkflowRecord(parsed)) {
    throw new Error(`The workflow ${id} is broken: its record has another format`);
  }
  return parsed;
}

/**
 * The ids of the workflows of the store — sorted by their id.
 *
 * The id of a workflow carries its Issue and the moment of its creation, so
 * the order of the ids is the order of the runs.
 *
 * A store that is not there yet holds no workflow. A store that cannot be
 * read holds an unknown number of them: the error is not swallowed, because
 * an empty list would let a second workflow of an Issue start next to the
 * first one.
 */
export async function listWorkflows(): Promise<string[]> {
  let entries: string[];
  try {
    // The listing is a read of the store: the privacy of the store is
    // enforced before it, and not only after a write.
    await enforceDirPrivacy(getWorkflowsDir());
    entries = await readdir(getWorkflowsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `The workflows cannot be listed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return entries.sort();
}

/**
 * Write a file of a workflow — the report of the run, for example.
 *
 * The file belongs to its owner alone: the links of the store are refused
 * before the write, the directory is made private, and the file is written
 * atomically with the mode of a private file. A report that is a link to
 * another file would write outside of the store.
 */
export async function writeWorkflowFile(
  id: string,
  name: string,
  content: string,
): Promise<string> {
  const file = path.join(getWorkflowDir(id), name);
  await refuseLinks(file);
  await privateDir(getWorkflowsDir());
  await privateDir(getWorkflowDir(id));
  await writeAtomic(file, content);
  return file;
}

/**
 * Append an event to the history of a workflow.
 *
 * The history is a part of the evidence of the run: it stays in the store, it
 * is a file of the owner alone, and it is never a link to another file.
 */
export async function appendEvent(id: string, event: WorkflowEvent): Promise<void> {
  const dir = getWorkflowDir(id);
  const file = eventsPath(id);
  // The links are refused before the directory is touched: `mkdir()` and
  // `chmod()` follow a link, and a refused append must not change anything
  // outside of the store either.
  await refuseLinks(file);
  await privateDir(dir);
  await enforcePrivacy(file);
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf-8');
  } finally {
    await handle.close();
  }
}

/**
 * The history of a workflow — the events, in the order they happened.
 *
 * A workflow that has no history yet has no file of events: that is an empty
 * history. Every other failure is an error — a history that cannot be read is
 * evidence that cannot be seen, and it is never reported as an empty one.
 *
 * The privacy of the history is enforced on the way in, not only on the way
 * out: a history that was restored from a backup, or whose mode was widened by
 * hand, is a history that everybody on the machine may read — and the read
 * itself makes it private again. The file is opened without following a link,
 * so a link that replaces it between the check and the read does not take the
 * read outside of the store.
 */
export async function readEvents(id: string): Promise<WorkflowEvent[]> {
  const file = eventsPath(id);
  let content: string;
  try {
    await refuseLinks(file);
    await enforcePrivacy(file);
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Cannot read the history of the workflow ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const events: WorkflowEvent[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as WorkflowEvent;
      if (typeof parsed?.at === 'string' && typeof parsed?.detail === 'string') {
        events.push(parsed);
      }
    } catch {
      // A broken line is a line that was cut: the events before it still count.
    }
  }
  return events;
}
