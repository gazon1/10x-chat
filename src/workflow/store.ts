import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  'completed',
  'blocked',
  'cancelled',
];

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
  return true;
}

/** Write the record of a workflow. */
export async function saveWorkflow(record: WorkflowRecord): Promise<void> {
  const dir = getWorkflowDir(record.id);
  await privateDir(getWorkflowsDir());
  await privateDir(dir);
  await writeAtomic(
    recordPath(record.id),
    `${JSON.stringify({ ...record, version: RECORD_VERSION }, null, 2)}\n`,
  );
}

/** Read the record of a workflow. */
export async function loadWorkflow(id: string): Promise<WorkflowRecord> {
  const file = recordPath(id);
  let content: string;
  try {
    content = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Workflow not found: ${id}`);
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

/** The ids of the workflows of the store — the newest first. */
export async function listWorkflows(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(getWorkflowsDir());
  } catch {
    return [];
  }
  return entries.sort();
}

/** Append an event to the history of a workflow. */
export async function appendEvent(id: string, event: WorkflowEvent): Promise<void> {
  const dir = getWorkflowDir(id);
  await privateDir(dir);
  await appendFile(eventsPath(id), `${JSON.stringify(event)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** The history of a workflow — the events, in the order they happened. */
export async function readEvents(id: string): Promise<WorkflowEvent[]> {
  let content: string;
  try {
    content = await readFile(eventsPath(id), 'utf-8');
  } catch {
    return [];
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
