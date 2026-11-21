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
  }): Promise<OrcaWorktree>;
  worktreeList(repoId: string): Promise<OrcaWorktree[]>;
  worktreeComment(selector: string, comment: string): Promise<void>;
  runCreate(objective: string): Promise<string>;
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
  send(options: { to: string; subject: string; body: string }): Promise<void>;
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
    ]);
    const worktree = isRecord(result) && isRecord(result.worktree) ? result.worktree : result;
    const id = findString(worktree, ['id']);
    const path = findString(worktree, ['path', 'worktreePath', 'checkoutPath']);
    if (!id || !path) {
      throw new OrcaError('orca worktree create answered without the worktree it created');
    }
    const branch = findString(worktree, ['branch']);
    const head = findString(worktree, ['head', 'headSha', 'sha']);
    return { id, path, ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
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
      worktrees.push({
        id,
        path,
        ...(name ? { name } : {}),
        ...(branch ? { branch } : {}),
        ...(head ? { head } : {}),
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
    const worktreePath = findString(result, ['worktreePath']);
    const branch = findString(result, ['branch']);
    const state = findString(result, ['state', 'status']);
    return {
      dispatchId,
      ...(taskId ? { taskId } : {}),
      runId: options.runId,
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
      ...(state ? { state } : {}),
    };
  }

  async workerShow(dispatchId: string): Promise<OrcaWorker> {
    const result = await this.call(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const id = findString(result, ['dispatchId']) ?? dispatchId;
    const taskId = findString(result, ['taskId']);
    const state = findString(result, ['state', 'status', 'taskStatus']);
    const outcome = findString(result, ['outcome']);
    const worktreePath = findString(result, ['worktreePath']);
    return {
      dispatchId: id,
      ...(taskId ? { taskId } : {}),
      ...(state ? { state } : {}),
      ...(outcome ? { state: outcome } : {}),
      ...(worktreePath ? { worktreePath } : {}),
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
      workers.push({
        dispatchId,
        ...(taskId ? { taskId } : {}),
        runId,
        ...(state ? { state } : {}),
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
      workers.push({
        dispatchId,
        ...(taskId ? { taskId } : {}),
        runId,
        ...(state ? { state } : {}),
      });
    }
    return workers;
  }

  async workerStop(dispatchId: string): Promise<void> {
    await this.call(['orchestration', 'worker-stop', '--dispatch', dispatchId]);
  }

  async send(options: { to: string; subject: string; body: string }): Promise<void> {
    await this.call([
      'orchestration',
      'send',
      '--to',
      options.to,
      '--subject',
      options.subject,
      '--body',
      options.body,
    ]);
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
      messages.push({
        type: 'worker_done',
        ...(findString(entry, ['dispatchId'])
          ? { dispatchId: findString(entry, ['dispatchId']) }
          : {}),
        ...(outcome ? { outcome } : {}),
        ...(text ? { text } : {}),
      });
    }
    for (const entry of collectByType(result, 'escalation')) {
      messages.push({
        type: 'escalation',
        ...(findString(entry, ['dispatchId'])
          ? { dispatchId: findString(entry, ['dispatchId']) }
          : {}),
        ...(findString(entry, ['reason', 'stopReason', 'message'])
          ? { text: findString(entry, ['reason', 'stopReason', 'message']) }
          : {}),
      });
    }
    return messages;
  }
}
