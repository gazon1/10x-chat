import { nodeProcessRunner, type ProcessRunner } from '../backend/process-runner.js';

/**
 * The adapter of the Orca CLI.
 *
 * Orca owns the worktrees and the coding agents; 10x-chat only speaks to it
 * through its command line and reads the JSON envelope it answers with. The
 * adapter is narrow on purpose: it speaks the verbs the workflow needs and
 * nothing else, and every answer of the CLI is data that is checked before it
 * is used — the CLI is another program.
 */

/** The failure of an Orca command — the message is what the user acts on. */
export class OrcaError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OrcaError';
  }
}

/** The readiness of the Orca runtime. */
export interface OrcaStatus {
  /** The runtime answers and is ready. */
  ready: boolean;
  /** The capabilities of the runtime. */
  capabilities: string[];
  /** Why the runtime is not ready, when it is not. */
  detail?: string;
}

/** A repository registered in Orca. */
export interface OrcaRepo {
  id: string;
  path: string;
  displayName: string;
  /** The canonical identity of the remote — `github.com/owner/name`. */
  canonicalKey?: string;
}

/** A worktree of Orca. */
export interface OrcaWorktree {
  id: string;
  path: string;
  /** The name of the worktree — the name the workflow gave it. */
  name?: string;
  branch?: string;
  head?: string;
  /** The comment of the worktree — the checkpoint of the workflow lives there. */
  comment?: string;
  /** The GitHub Issue the worktree is linked to — the ownership of the Issue. */
  linkedIssue?: number;
  /** Whether the worktree is the checkout of the user — it is never reused. */
  isMainWorktree?: boolean;
}

/** The Run of the orchestration — the home of the mailbox of a worker. */
export interface OrcaRun {
  /** The id of the Run. */
  id: string;
  /** What the Run is for — the objective of the workflow. */
  objective?: string;
}

/** The worker that Orca supervises — the Dispatch of the orchestration. */
export interface OrcaWorker {
  /** The id of the Dispatch — the handle of the worker. */
  dispatchId: string;
  /** The id of the Task the worker settles. */
  taskId?: string;
  /** The Run the worker belongs to. */
  runId?: string;
  /** The worktree the worker works in. */
  worktreePath?: string;
  /** The branch of the worktree. */
  branch?: string;
  /** The state of the Dispatch — `ready`, `working`, `settled`, … */
  state?: string;
  /** The title of the task of the worker — what it was asked to do. */
  taskTitle?: string;
  /** The structured outcome of the Dispatch — `succeeded` or `failed`. */
  outcome?: string;
  /** The report of the worker — what it did and how it verified it. */
  report?: string;
}

/** A message of the mailbox of a Run. */
export interface OrcaMessage {
  type: string;
  /** The Dispatch the message is about. */
  dispatchId?: string;
  /** `succeeded` or `failed` — the outcome of a `worker_done`. */
  outcome?: string;
  /** The text of the message — the report of a worker. */
  text?: string;
}

/** The verbs of Orca that the workflow uses. */
export interface OrcaApi {
  status(): Promise<OrcaStatus>;
  repoList(): Promise<OrcaRepo[]>;
  worktreeCreate(options: {
    repoId: string;
    name: string;
    branch: string;
    baseRef: string;
    issue: number;
    /** The comment that names the owner of the worktree — the workflow writes it at once. */
    comment: string;
  }): Promise<OrcaWorktree>;
  worktreeList(repoId: string): Promise<OrcaWorktree[]>;
  worktreeComment(selector: string, comment: string): Promise<void>;
  runCreate(objective: string): Promise<string>;
  runList(): Promise<OrcaRun[]>;
  workerStart(options: {
    runId: string;
    spec: string;
    worktree: string;
    agent: string;
    taskTitle: string;
  }): Promise<OrcaWorker>;
  workerShow(dispatchId: string): Promise<OrcaWorker>;
  workerList(runId: string): Promise<OrcaWorker[]>;
  workerStop(dispatchId: string): Promise<void>;
  check(runId: string, options: { timeoutMs: number; types: string[] }): Promise<OrcaMessage[]>;
}

/** The options of the adapter. */
export interface OrcaClientOptions {
  /** The command of the CLI — the one on the PATH by default. */
  command?: string;
  /** The runner of the processes — the real one by default. */
  runner?: ProcessRunner;
  /** The timeout of a command — the long waits pass their own. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Whether a value is an object that can carry fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The key of a field, without the difference of the writing. */
function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

/**
 * The value of the first field of the names — anywhere in the answer.
 *
 * The shape of the answer of the CLI is not a contract of this repository:
 * the fields are looked up by name, the nearest one first, so that a version
 * of Orca that nests its answer differently still answers.
 */
function findValue(payload: unknown, names: string[]): unknown {
  const wanted = new Set(names.map(normalizeKey));
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(normalizeKey(key))) return value;
    }
    queue.push(...Object.values(current));
  }
  return undefined;
}

/** The text of the first field of the names. */
function findString(payload: unknown, names: string[]): string | undefined {
  const value = findValue(payload, names);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The worktree a worker works in.
 *
 * The runtime names it in several ways, and the shape of its answer is not a
 * contract: the worktree is read as a field of its own, as a path of a nested
 * object, and under the name of the checkout. A worker whose worktree cannot
 * be read is a worker the workflow cannot prove — it refuses it, and it must
 * not refuse it because the runtime spelled the name differently.
 */
function worktreePathOf(payload: unknown): string | undefined {
  const direct = findString(payload, ['worktreePath', 'checkoutPath', 'worktree']);
  if (direct) return direct;
  const value = findValue(payload, ['worktree']);
  if (isRecord(value)) return findString(value, ['path', 'worktreePath', 'checkoutPath']);
  return undefined;
}

/** The branch a worker works on — the branch of its worktree. */
function branchOf(payload: unknown): string | undefined {
  return findString(payload, ['branch', 'gitBranch']);
}

/** The title of the task of a worker — what it was asked to do. */
function taskTitleOf(payload: unknown): string | undefined {
  return findString(payload, ['taskTitle']);
}

/** The number of an answer — the number of an Issue, for example. */
function findNumber(payload: unknown, names: string[]): number | undefined {
  const value = findValue(payload, names);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The objects of the answer that carry a type of their own. */
function collectByType(payload: unknown, type: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    if (current.type === type) found.push(current);
    queue.push(...Object.values(current));
  }
  return found;
}

/**
 * The fields a message of the mailbox may name its Dispatch with.
 *
 * The shape of the answer of the CLI is not a contract of this repository: the
 * Dispatch is looked up by name, so that a version of Orca that writes it
 * differently still answers. A message that names no Dispatch is ambiguous
 * when the Run has more than one worker.
 */
const DISPATCH_FIELDS = ['dispatchId', 'dispatch', 'dispatch_id', 'workerDispatchId'];

/** The message of an error of the CLI. */
function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  const found = findString(value, ['message', 'detail', 'reason']);
  return found;
}

/** The adapter of the real Orca CLI. */
export class OrcaClient implements OrcaApi {
  private readonly command: string;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: OrcaClientOptions = {}) {
    this.command = options.command ?? 'orca';
    this.runner = options.runner ?? nodeProcessRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Run one command of the CLI and return the payload of its answer. */
  private async call(args: string[], timeoutMs = this.timeoutMs): Promise<unknown> {
    let stdout = '';
    let stderr = '';
    let code = 0;
    let timedOut = false;
    try {
      const result = await this.runner.run(this.command, [...args, '--json'], { timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code ?? 0;
      timedOut = result.timedOut;
    } catch (error) {
      throw new OrcaError(
        `Cannot run '${this.command}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (timedOut) {
      throw new OrcaError(`orca ${args.join(' ')} did not answer within ${timeoutMs}ms`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(stdout.trim());
    } catch {
      payload = undefined;
    }
    if (payload === undefined) {
      const reason = stderr.trim() || stdout.trim() || `orca exited with ${code}`;
      throw new OrcaError(`orca ${args.join(' ')} answered with no JSON: ${reason}`);
    }
    const envelope = isRecord(payload) ? payload : undefined;
    if (envelope && envelope.ok === false) {
      throw new OrcaError(
        `orca ${args.join(' ')} failed: ${messageOf(envelope.error) ?? 'the reason is unknown'}`,
        envelope.error,
      );
    }
    // A command that failed is a failed command, whatever its answer says: a
    // JSON diagnostic of a non-zero exit is not the result of the operation.
    if (code !== 0) {
      const reason =
        (envelope ? messageOf(envelope.error) : undefined) ||
        stderr.trim() ||
        stdout.trim() ||
        `the exit code is ${code}`;
      throw new OrcaError(`orca ${args.join(' ')} failed: ${reason}`, envelope?.error);
    }
    if (envelope && 'result' in envelope) return envelope.result;
    return payload;
  }

  async status(): Promise<OrcaStatus> {
    const result = await this.call(['status']);
    const runtime = isRecord(result) ? result.runtime : undefined;
    const graph = isRecord(result) ? result.graph : undefined;
    const runtimeRecord = isRecord(runtime) ? runtime : undefined;
    const graphRecord = isRecord(graph) ? graph : undefined;
    const capabilities = Array.isArray(runtimeRecord?.capabilities)
      ? runtimeRecord.capabilities.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const reachable = runtimeRecord?.reachable === true;
    const state = typeof runtimeRecord?.state === 'string' ? runtimeRecord.state : 'unknown';
    const graphState = typeof graphRecord?.state === 'string' ? graphRecord.state : 'unknown';
    const ready = reachable && state === 'ready' && graphState === 'ready';
    return {
      ready,
      capabilities,
      ...(ready
        ? {}
        : {
            detail: `the runtime is ${state} (${reachable ? 'reachable' : 'not reachable'}), the graph is ${graphState}`,
          }),
    };
  }

  async repoList(): Promise<OrcaRepo[]> {
    const result = await this.call(['repo', 'list']);
    const repos = isRecord(result) ? result.repos : undefined;
    if (!Array.isArray(repos)) return [];
    const parsed: OrcaRepo[] = [];
    for (const entry of repos) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const path = typeof entry.path === 'string' ? entry.path : undefined;
      if (!id || !path) continue;
      const identity = isRecord(entry.gitRemoteIdentity) ? entry.gitRemoteIdentity : undefined;
      const canonicalKey =
        typeof identity?.canonicalKey === 'string' ? identity.canonicalKey : undefined;
      parsed.push({
        id,
        path,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : path,
        ...(canonicalKey ? { canonicalKey } : {}),
      });
    }
    return parsed;
  }

  async worktreeCreate(options: {
    repoId: string;
    name: string;
    branch: string;
    baseRef: string;
    issue: number;
    comment: string;
  }): Promise<OrcaWorktree> {
    const result = await this.call([
      'worktree',
      'create',
      '--repo',
      `id:${options.repoId}`,
      '--name',
      options.name,
      '--branch',
      options.branch,
      '--base-branch',
      options.baseRef,
      '--issue',
      String(options.issue),
      '--comment',
      options.comment,
    ]);
    const worktree = isRecord(result) && isRecord(result.worktree) ? result.worktree : result;
    const id = findString(worktree, ['id']);
    const path = findString(worktree, ['path', 'worktreePath', 'checkoutPath']);
    if (!id || !path) {
      throw new OrcaError('orca worktree create answered without the worktree it created');
    }
    const branch = findString(worktree, ['branch']);
    const head = findString(worktree, ['head', 'headSha', 'sha']);
    const comment = findString(worktree, ['comment', 'description']);
    const linkedIssue = findNumber(worktree, ['linkedIssue']);
    return {
      id,
      path,
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      ...(comment ? { comment } : {}),
      ...(linkedIssue !== undefined ? { linkedIssue } : {}),
    };
  }

  async worktreeComment(selector: string, comment: string): Promise<void> {
    await this.call(['worktree', 'set', '--worktree', selector, '--comment', comment]);
  }

  /**
   * The worktrees of a repository.
   *
   * The list is how a lost answer is reconciled: a worktree that is already
   * there is adopted instead of created a second time.
   */
  async worktreeList(repoId: string): Promise<OrcaWorktree[]> {
    const result = await this.call(['worktree', 'list', '--repo', `id:${repoId}`]);
    const list = findValue(result, ['worktrees']);
    if (!Array.isArray(list)) return [];
    const worktrees: OrcaWorktree[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const id = findString(entry, ['id']);
      const path = findString(entry, ['path']);
      if (!id || !path) continue;
      const name = findString(entry, ['displayName', 'name']);
      const branch = findString(entry, ['branch']);
      const head = findString(entry, ['head', 'headSha', 'sha']);
      const comment = findString(entry, ['comment', 'description']);
      const linkedIssue = findNumber(entry, ['linkedIssue']);
      const isMain = findValue(entry, ['isMainWorktree']);
      worktrees.push({
        id,
        path,
        ...(name ? { name } : {}),
        ...(branch ? { branch } : {}),
        ...(head ? { head } : {}),
        ...(comment ? { comment } : {}),
        ...(linkedIssue !== undefined ? { linkedIssue } : {}),
        ...(typeof isMain === 'boolean' ? { isMainWorktree: isMain } : {}),
      });
    }
    return worktrees;
  }

  async runCreate(objective: string): Promise<string> {
    const result = await this.call(['orchestration', 'run-create', '--objective', objective]);
    const id = findString(result, ['runId', 'id']);
    if (!id) throw new OrcaError('orca orchestration run-create answered without a run id');
    return id;
  }

  async runList(): Promise<OrcaRun[]> {
    const result = await this.call(['orchestration', 'run-list']);
    const list = findValue(result, ['runs']);
    if (!Array.isArray(list)) return [];
    const runs: OrcaRun[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const id = findString(entry, ['id', 'runId']);
      if (!id) continue;
      const objective = findString(entry, ['objective', 'title', 'name']);
      runs.push({ id, ...(objective ? { objective } : {}) });
    }
    return runs;
  }

  async workerStart(options: {
    runId: string;
    spec: string;
    worktree: string;
    agent: string;
    taskTitle: string;
  }): Promise<OrcaWorker> {
    const result = await this.call([
      'orchestration',
      'worker-start',
      '--run',
      options.runId,
      '--spec',
      options.spec,
      '--worktree',
      options.worktree,
      '--agent',
      options.agent,
      '--task-title',
      options.taskTitle,
    ]);
    const dispatchId = findString(result, ['dispatchId']);
    if (!dispatchId) {
      throw new OrcaError('orca orchestration worker-start answered without a dispatch id');
    }
    const taskId = findString(result, ['taskId']);
    const worktreePath = worktreePathOf(result);
    const branch = branchOf(result);
    const state = findString(result, ['state', 'status']);
    // The title of the task is the title the command was given: the runtime
    // does not have to name it again for the workflow to know which task a
    // worker works on.
    const taskTitle = taskTitleOf(result) ?? options.taskTitle;
    return {
      dispatchId,
      ...(taskId ? { taskId } : {}),
      runId: options.runId,
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
      ...(state ? { state } : {}),
      ...(taskTitle ? { taskTitle } : {}),
    };
  }

  async workerShow(dispatchId: string): Promise<OrcaWorker> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const id = findString(result, ['dispatchId']) ?? dispatchId;
    const taskId = findString(result, ['taskId']);
    const state = findString(result, ['state', 'status', 'taskStatus']);
    // The outcome is a field of its own: it is the structured result of the
    // Task, and it is not the state of the Dispatch.
    const outcome = findString(result, ['outcome', 'result.outcome', 'task.outcome']);
    const report = findString(result, ['report', 'summary', 'result.report', 'result.text']);
    const worktreePath = worktreePathOf(result);
    const branch = branchOf(result);
    const taskTitle = taskTitleOf(result);
    return {
      dispatchId: id,
      ...(taskId ? { taskId } : {}),
      ...(state ? { state } : {}),
      ...(outcome ? { outcome } : {}),
      ...(report ? { report } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
      ...(taskTitle ? { taskTitle } : {}),
    };
  }

  async workerList(runId: string): Promise<OrcaWorker[]> {
    const result = await this.call(['orchestration', 'worker-list', '--run', runId]);
    const workers: OrcaWorker[] = [];
    for (const entry of collectByType(result, 'dispatch')) {
      const dispatchId = findString(entry, ['dispatchId', 'id']);
      if (!dispatchId) continue;
      const taskId = findString(entry, ['taskId']);
      const state = findString(entry, ['state', 'status', 'taskStatus']);
      // The worktree, the branch and the title of the task are the identity
      // of the worker: the list of the workers is not only their states.
      const worktreePath = worktreePathOf(entry);
      const branch = branchOf(entry);
      const taskTitle = taskTitleOf(entry);
      workers.push({
        dispatchId,
        ...(taskId ? { taskId } : {}),
        runId,
        ...(state ? { state } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(branch ? { branch } : {}),
        ...(taskTitle ? { taskTitle } : {}),
      });
    }
    if (workers.length > 0) return workers;
    // The shape of the answer is not a contract: a list of the workers is
    // read as well, so that a version that does not name the type of a row
    // still answers.
    const list = findValue(result, ['workers', 'dispatches', 'rows']);
    if (!Array.isArray(list)) return [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const dispatchId = findString(entry, ['dispatchId', 'id']);
      if (!dispatchId) continue;
      const taskId = findString(entry, ['taskId']);
      const state = findString(entry, ['state', 'status', 'taskStatus']);
      const worktreePath = worktreePathOf(entry);
      const branch = branchOf(entry);
      const taskTitle = taskTitleOf(entry);
      workers.push({
        dispatchId,
        ...(taskId ? { taskId } : {}),
        runId,
        ...(state ? { state } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(branch ? { branch } : {}),
        ...(taskTitle ? { taskTitle } : {}),
      });
    }
    return workers;
  }

  async workerStop(dispatchId: string): Promise<void> {
    await this.call(['orchestration', 'worker-stop', '--dispatch', dispatchId]);
  }

  async check(
    runId: string,
    options: { timeoutMs: number; types: string[] },
  ): Promise<OrcaMessage[]> {
    const result = await this.call(
      [
        'orchestration',
        'check',
        '--run',
        runId,
        '--wait',
        '--timeout-ms',
        String(options.timeoutMs),
        '--types',
        options.types.join(','),
      ],
      options.timeoutMs + 30_000,
    );
    const messages: OrcaMessage[] = [];
    for (const entry of collectByType(result, 'worker_done')) {
      const outcome = findString(entry, ['outcome']);
      const text = findString(entry, ['result', 'report', 'text', 'body', 'summary']) ?? undefined;
      const dispatch = findString(entry, DISPATCH_FIELDS);
      messages.push({
        type: 'worker_done',
        ...(dispatch ? { dispatchId: dispatch } : {}),
        ...(outcome ? { outcome } : {}),
        ...(text ? { text } : {}),
      });
    }
    for (const entry of collectByType(result, 'escalation')) {
      const dispatch = findString(entry, DISPATCH_FIELDS);
      messages.push({
        type: 'escalation',
        ...(dispatch ? { dispatchId: dispatch } : {}),
        ...(findString(entry, ['reason', 'stopReason', 'message'])
          ? { text: findString(entry, ['reason', 'stopReason', 'message']) }
          : {}),
      });
    }
    return messages;
  }
}
