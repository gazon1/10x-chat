import {
  nodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from '../backend/process-runner.js';
import type {
  KnowledgeAnswer,
  KnowledgeFailure,
  KnowledgeFailureKind,
  KnowledgeNotebook,
  KnowledgeOutcome,
  KnowledgeProvider,
  KnowledgeReference,
  KnowledgeSource,
  KnowledgeStatus,
} from './contract.js';

/** The name of the provider in the registry. */
export const NOTEBOOKLM_PROVIDER_NAME = 'notebooklm';

/** How long an operation may take before it is killed. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The options of the provider. */
export interface NotebookLmOptions {
  /** The command of the CLI — the one on the PATH by default. */
  command?: string;
  /** The runner of the processes — the real one by default. */
  runner?: ProcessRunner;
  /** The profile of `notebooklm-py` to use — its own auth store. */
  profile?: string;
  /** The deadline of an operation in milliseconds. */
  timeoutMs?: number;
}

/**
 * The kinds of the failure codes of the CLI.
 *
 * A code that is not listed here is a rejection: the CLI refused the
 * operation for a reason it did not name.
 */
const FAILURE_KIND_OF: Record<string, KnowledgeFailureKind> = {
  AUTH_ERROR: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  NETWORK_ERROR: 'unavailable',
  NOT_FOUND: 'rejected',
  VALIDATION_ERROR: 'rejected',
  CONFIG_ERROR: 'rejected',
  NOTEBOOK_LIMIT: 'rejected',
  ARTIFACT_TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  NOTEBOOKLM_ERROR: 'rejected',
};

/** Is the value a JSON object? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The string of a field, or undefined when the field is not a string. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The failure of an error envelope of the CLI. */
function failureFromEnvelope(envelope: Record<string, unknown>): KnowledgeFailure {
  const code = str(envelope, 'code');
  const message = str(envelope, 'message') ?? 'The provider refused the operation.';
  return {
    kind: (code ? FAILURE_KIND_OF[code] : undefined) ?? 'rejected',
    message,
    ...(code ? { code } : {}),
  };
}

/**
 * Create the NotebookLM provider.
 *
 * The provider drives the `notebooklm` CLI of `notebooklm-py`: it owns the
 * login and the credentials of the account, and 10x-chat never sees them.
 * The CLI is started without a shell, so a title, a URL or a question is
 * never interpolated into a command line.
 */
export function createNotebookLmProvider(options: NotebookLmOptions = {}): KnowledgeProvider {
  const command = options.command ?? NOTEBOOKLM_PROVIDER_NAME;
  const runner = options.runner ?? nodeProcessRunner;
  const profile = options.profile;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * Run the CLI and decode its JSON.
   *
   * The stdout of the CLI is the only thing that is decoded: its diagnostics
   * stay on its stderr, so a log line never breaks the answer.
   */
  const invoke = async (
    args: string[],
    options_: { mutating?: boolean; tolerateExit?: boolean } = {},
  ): Promise<KnowledgeOutcome<unknown>> => {
    let result: ProcessResult;
    try {
      result = await runner.run(command, [...(profile ? ['--profile', profile] : []), ...args], {
        timeoutMs,
      });
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'unavailable',
          message: `The "${command}" executable could not be started: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
    // A killed process may have run the operation: the state is unknown.
    const mayHaveRun = options_.mutating === true;
    if (result.timedOut) {
      return {
        ok: false,
        failure: {
          kind: 'timeout',
          message: `The provider did not answer in ${timeoutMs} ms.`,
          ...(mayHaveRun ? { mayHaveRun: true } : {}),
        },
      };
    }
    const text = result.stdout.trim();
    let decoded: unknown;
    if (text !== '') {
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = undefined;
      }
    }
    if (isRecord(decoded) && decoded.error === true) {
      return { ok: false, failure: failureFromEnvelope(decoded) };
    }
    if (result.code !== 0 && options_.tolerateExit !== true) {
      const diagnostics = result.stderr.trim() || text;
      return {
        ok: false,
        failure: {
          kind: 'rejected',
          message: diagnostics || `The provider exited with the code ${result.code}.`,
          ...(mayHaveRun ? { mayHaveRun: true } : {}),
        },
      };
    }
    if (decoded === undefined) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_output',
          message: 'The provider did not answer with JSON.',
          ...(mayHaveRun ? { mayHaveRun: true } : {}),
        },
      };
    }
    return { ok: true, value: decoded };
  };

  /** The failure of an answer that is not the shape we expect. */
  const invalid = (what: string): KnowledgeFailure => ({
    kind: 'invalid_output',
    message: `The provider did not answer with ${what}.`,
  });

  /** A notebook of the JSON of the CLI. */
  const notebook = (raw: unknown): KnowledgeNotebook | undefined => {
    if (!isRecord(raw)) return undefined;
    const id = str(raw, 'id');
    if (!id) return undefined;
    const role = str(raw, 'role');
    const createdAt = str(raw, 'created_at');
    return {
      id,
      title: str(raw, 'title') ?? '',
      ...(role ? { role } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  };

  /** A source of the JSON of the CLI. */
  const source = (raw: unknown): KnowledgeSource | undefined => {
    if (!isRecord(raw)) return undefined;
    const id = str(raw, 'id');
    if (!id) return undefined;
    const type = str(raw, 'type');
    const url = str(raw, 'url');
    const status = str(raw, 'status');
    return {
      id,
      title: str(raw, 'title') ?? '',
      ...(type ? { type } : {}),
      ...(url ? { url } : {}),
      ...(status ? { status } : {}),
    };
  };

  return {
    name: NOTEBOOKLM_PROVIDER_NAME,

    async status(): Promise<KnowledgeOutcome<KnowledgeStatus>> {
      // The auth check of the CLI: it validates the local material and — with
      // `--test` — asks NotebookLM for a token. The probe is passive: it never
      // rotates a cookie and never writes to disk, so a status check has no
      // side effect on the profile of the user.
      const outcome = await invoke(['auth', 'check', '--test', '--passive', '--json'], {
        tolerateExit: true,
      });
      if (!outcome.ok) {
        // The CLI answered — it is there — but it refused the call: the
        // session is not logged in.
        if (outcome.failure.kind === 'unauthorized') {
          return {
            ok: true,
            value: {
              available: true,
              authenticated: false,
              ...(profile ? { profile } : {}),
              message: outcome.failure.message,
            },
          };
        }
        return outcome;
      }
      const raw = outcome.value;
      if (!isRecord(raw)) return { ok: false, failure: invalid('the state of the provider') };
      const details = isRecord(raw.details) ? raw.details : undefined;
      const reportedProfile = str(raw, 'profile');
      if (str(raw, 'status') === 'ok') {
        return {
          ok: true,
          value: {
            available: true,
            authenticated: true,
            ...((profile ?? reportedProfile) ? { profile: profile ?? reportedProfile } : {}),
          },
        };
      }
      return {
        ok: true,
        value: {
          available: true,
          authenticated: false,
          ...((profile ?? reportedProfile) ? { profile: profile ?? reportedProfile } : {}),
          message:
            (details ? str(details, 'error') : undefined) ?? 'The provider is not logged in.',
        },
      };
    },

    async listNotebooks(): Promise<KnowledgeOutcome<KnowledgeNotebook[]>> {
      const outcome = await invoke(['list', '--json']);
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      const items = isRecord(raw) ? raw.notebooks : undefined;
      if (!Array.isArray(items)) return { ok: false, failure: invalid('a list of notebooks') };
      const notebooks: KnowledgeNotebook[] = [];
      for (const item of items) {
        const parsed = notebook(item);
        if (!parsed) return { ok: false, failure: invalid('a list of notebooks') };
        notebooks.push(parsed);
      }
      return { ok: true, value: notebooks };
    },

    async createNotebook(title: string): Promise<KnowledgeOutcome<KnowledgeNotebook>> {
      // The `--` ends the options of the CLI: a title that starts with a dash
      // is a title, not an option.
      const outcome = await invoke(['create', '--json', '--', title], { mutating: true });
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      const parsed = notebook(isRecord(raw) ? raw.notebook : undefined);
      if (!parsed) return { ok: false, failure: invalid('a notebook') };
      return { ok: true, value: parsed };
    },

    async addSource(notebookId: string, url: string): Promise<KnowledgeOutcome<KnowledgeSource>> {
      const outcome = await invoke(['source', 'add', url, '--notebook', notebookId, '--json'], {
        mutating: true,
      });
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      const parsed = source(isRecord(raw) ? raw.source : undefined);
      if (!parsed) return { ok: false, failure: invalid('a source') };
      return { ok: true, value: parsed };
    },

    async listSources(notebookId: string): Promise<KnowledgeOutcome<KnowledgeSource[]>> {
      const outcome = await invoke(['source', 'list', '--notebook', notebookId, '--json']);
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      const items = isRecord(raw) ? raw.sources : undefined;
      if (!Array.isArray(items)) return { ok: false, failure: invalid('a list of sources') };
      const sources: KnowledgeSource[] = [];
      for (const item of items) {
        const parsed = source(item);
        if (!parsed) return { ok: false, failure: invalid('a list of sources') };
        sources.push(parsed);
      }
      return { ok: true, value: sources };
    },

    async refreshSource(
      notebookId: string,
      sourceId: string,
    ): Promise<KnowledgeOutcome<KnowledgeSource>> {
      const outcome = await invoke(
        ['source', 'refresh', sourceId, '--notebook', notebookId, '--json'],
        { mutating: true },
      );
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      if (!isRecord(raw)) return { ok: false, failure: invalid('a refreshed source') };
      const id = str(raw, 'source_id');
      if (!id) return { ok: false, failure: invalid('a refreshed source') };
      const title = str(raw, 'title');
      const status = str(raw, 'status');
      return {
        ok: true,
        value: {
          id,
          title: title ?? '',
          ...(status ? { status } : {}),
        },
      };
    },

    async ask(
      notebookId: string,
      question: string,
      askOptions: { sources?: string[] } = {},
    ): Promise<KnowledgeOutcome<KnowledgeAnswer>> {
      const args = ['ask', '--notebook', notebookId];
      for (const source of askOptions.sources ?? []) {
        args.push('--source', source);
      }
      // The `--` ends the options of the CLI: a question that starts with a
      // dash is a question, not an option.
      args.push('--json', '--', question);
      const outcome = await invoke(args, { mutating: true });
      if (!outcome.ok) return outcome;
      const raw = outcome.value;
      if (!isRecord(raw)) return { ok: false, failure: invalid('an answer') };
      const answer = str(raw, 'answer');
      if (!answer) return { ok: false, failure: invalid('an answer') };
      const conversationId = str(raw, 'conversation_id');
      const rawReferences = raw.references;
      const references: KnowledgeReference[] = [];
      if (Array.isArray(rawReferences)) {
        for (const item of rawReferences) {
          if (!isRecord(item)) continue;
          const sourceId = str(item, 'source_id');
          if (!sourceId) continue;
          const citationNumber = item.citation_number;
          references.push({
            sourceId,
            ...(typeof citationNumber === 'number' ? { citationNumber } : {}),
          });
        }
      }
      return {
        ok: true,
        value: {
          answer,
          ...(conversationId ? { conversationId } : {}),
          ...(references.length > 0 ? { references } : {}),
        },
      };
    },
  };
}
