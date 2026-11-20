import { describe, expect, it } from 'vitest';
import type { ProcessResult, ProcessRunner } from '../src/backend/process-runner.js';
import type { KnowledgeProvider } from '../src/knowledge/contract.js';
import { createNotebookLmProvider, NOTEBOOKLM_PROVIDER_NAME } from '../src/knowledge/notebooklm.js';
import {
  getKnowledgeProvider,
  listKnowledgeProviders,
  registerKnowledgeProvider,
  resetKnowledgeProviders,
} from '../src/knowledge/registry.js';

/** A call of the runner of the tests. */
interface Call {
  command: string;
  args: string[];
  timeoutMs?: number;
}

/** A runner that answers with canned results and records the calls. */
function fakeRunner(results: ProcessResult[] | ((args: string[]) => ProcessResult)): {
  runner: ProcessRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const runner: ProcessRunner = {
    run(command, args, options) {
      calls.push({
        command,
        args,
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (typeof results === 'function') return Promise.resolve(results(args));
      const result = results[index] ?? { code: 0, stdout: '{}', stderr: '', timedOut: false };
      index += 1;
      return Promise.resolve(result);
    },
  };
  return { runner, calls };
}

/** A result of the runner. */
function ok(stdout: unknown): ProcessResult {
  return { code: 0, stdout: JSON.stringify(stdout), stderr: '', timedOut: false };
}

describe('the NotebookLM provider', () => {
  it('runs the CLI without a shell and passes the arguments one by one', async () => {
    const { runner, calls } = fakeRunner([
      ok({ source: { id: 's1', title: 'T', type: 'url', url: 'u' } }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.addSource('nb 1; rm -rf /', 'https://example.com/a?b=c&d=e');

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.command).toBe('notebooklm');
    // The title and the URL are arguments of the process — never a part of a
    // command line that a shell would read.
    expect(calls[0]?.args).toEqual([
      'source',
      'add',
      'https://example.com/a?b=c&d=e',
      '--notebook',
      'nb 1; rm -rf /',
      '--json',
    ]);
  });

  it('passes a free text that starts with a dash as a text', async () => {
    const { runner, calls } = fakeRunner([ok({ answer: 'yes' })]);
    const provider = createNotebookLmProvider({ runner });

    await provider.ask('nb1', '-what is it?');

    // The `--` ends the options of the CLI: the question is a question, not
    // an option.
    expect(calls[0]?.args).toEqual(['ask', '--notebook', 'nb1', '--json', '--', '-what is it?']);
  });

  it('passes the profile explicitly', async () => {
    const { runner, calls } = fakeRunner([ok({ notebooks: [], count: 0 })]);
    const provider = createNotebookLmProvider({ runner, profile: 'work' });

    await provider.listNotebooks();

    expect(calls[0]?.args).toEqual(['--profile', 'work', 'list', '--json']);
  });

  it('names the notebook of every operation that has one', async () => {
    const { runner, calls } = fakeRunner([
      ok({ sources: [], count: 0 }),
      ok({ action: 'refresh', source_id: 's1', status: 'refreshed' }),
      ok({ answer: 'yes' }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    await provider.listSources('nb-1');
    await provider.refreshSource('nb-1', 'src-1');
    await provider.ask('nb-1', 'what is it?');

    expect(calls[0]?.args).toEqual(['source', 'list', '--notebook', 'nb-1', '--json']);
    expect(calls[1]?.args).toEqual(['source', 'refresh', 'src-1', '--notebook', 'nb-1', '--json']);
    expect(calls[2]?.args).toEqual(['ask', '--notebook', 'nb-1', '--json', '--', 'what is it?']);
  });

  it('limits an answer to the sources that were named', async () => {
    const { runner, calls } = fakeRunner([ok({ answer: 'yes' })]);
    const provider = createNotebookLmProvider({ runner });

    await provider.ask('nb-1', 'what is it?', { sources: ['s1', 's2'] });

    expect(calls[0]?.args).toEqual([
      'ask',
      '--notebook',
      'nb-1',
      '--source',
      's1',
      '--source',
      's2',
      '--json',
      '--',
      'what is it?',
    ]);
  });

  it('creates a notebook with a title that is not an option', async () => {
    const { runner, calls } = fakeRunner([ok({ notebook: { id: 'nb1', title: '-Notes' } })]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.createNotebook('-Notes');

    expect(calls[0]?.args).toEqual(['create', '--json', '--', '-Notes']);
    expect(outcome.ok).toBe(true);
  });

  it('normalizes the notebooks and the sources of the CLI', async () => {
    const { runner } = fakeRunner([
      ok({
        notebooks: [
          {
            id: 'nb1',
            title: 'Research',
            role: 'owner',
            created_at: '2026-01-02T03:04:05',
          },
        ],
        count: 1,
      }),
      ok({
        source: { id: 's1', title: 'Article', type: 'url', url: 'https://example.com' },
      }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const notebooks = await provider.listNotebooks();
    expect(notebooks.ok).toBe(true);
    if (notebooks.ok) {
      expect(notebooks.value).toEqual([
        { id: 'nb1', title: 'Research', role: 'owner', createdAt: '2026-01-02T03:04:05' },
      ]);
    }

    const source = await provider.addSource('nb1', 'https://example.com');
    expect(source.ok).toBe(true);
    if (source.ok) {
      expect(source.value).toEqual({
        id: 's1',
        title: 'Article',
        type: 'url',
        url: 'https://example.com',
      });
    }
  });

  it('normalizes the answer and its references', async () => {
    const { runner } = fakeRunner([
      ok({
        answer: 'The key decision is A.',
        conversation_id: 'conv-1',
        references: [{ source_id: 's1', citation_number: 1 }],
      }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.ask('nb1', 'key decisions?');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({
        answer: 'The key decision is A.',
        conversationId: 'conv-1',
        references: [{ sourceId: 's1', citationNumber: 1 }],
      });
    }
  });

  it('fails when the CLI answers with something that is not JSON', async () => {
    const { runner } = fakeRunner([
      { code: 0, stdout: 'not json at all', stderr: '', timedOut: false },
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.listNotebooks();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('invalid_output');
    }
  });

  it('fails when the JSON does not have the shape it should have', async () => {
    const { runner } = fakeRunner([ok({ notebooks: [{ title: 'no id' }], count: 1 })]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.listNotebooks();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('invalid_output');
    }
  });

  it('reports a missing executable as unavailable', async () => {
    const runner: ProcessRunner = {
      run() {
        return Promise.reject(new Error('spawn notebooklm ENOENT'));
      },
    };
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.listNotebooks();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('unavailable');
      expect(outcome.failure.message).toMatch(/could not be started/);
    }
  });

  it('reports an authentication failure as unauthorized', async () => {
    const { runner } = fakeRunner([
      ok({ error: true, code: 'AUTH_ERROR', message: 'Authentication error: expired' }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.listNotebooks();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('unauthorized');
      expect(outcome.failure.code).toBe('AUTH_ERROR');
    }
  });

  it('reports the state of the provider without failing when it is not logged in', async () => {
    const { runner } = fakeRunner([
      ok({ error: true, code: 'AUTH_ERROR', message: 'Authentication error: expired' }),
    ]);
    const provider = createNotebookLmProvider({ runner, profile: 'work' });

    const outcome = await provider.status();

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.available).toBe(true);
      expect(outcome.value.authenticated).toBe(false);
      expect(outcome.value.profile).toBe('work');
    }
  });

  it('probes the authentication of the provider without touching its profile', async () => {
    const { runner, calls } = fakeRunner([
      {
        code: 1,
        stdout: JSON.stringify({
          status: 'error',
          profile: null,
          checks: { token_fetch: false },
          details: { error: 'Token fetch failed: Authentication expired or invalid.' },
        }),
        stderr: '',
        timedOut: false,
      },
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.status();

    // The probe is passive: it never rotates a cookie and never writes.
    expect(calls[0]?.args).toEqual(['auth', 'check', '--test', '--passive', '--json']);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.available).toBe(true);
      expect(outcome.value.authenticated).toBe(false);
      expect(outcome.value.message).toMatch(/expired/);
    }
  });

  it('reports a provider that is logged in', async () => {
    const { runner } = fakeRunner([
      ok({ status: 'ok', profile: 'default', checks: { token_fetch: true }, details: {} }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.status();

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.authenticated).toBe(true);
      expect(outcome.value.profile).toBe('default');
    }
  });

  it('reports a timeout as a failure that may have run', async () => {
    const { runner } = fakeRunner([{ code: null, stdout: '', stderr: '', timedOut: true }]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.addSource('nb1', 'https://example.com');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('timeout');
      // The source may have been added: it must not be added again blind.
      expect(outcome.failure.mayHaveRun).toBe(true);
    }
  });

  it('maps a rate limit and a rejection to their kinds', async () => {
    const { runner } = fakeRunner([
      ok({ error: true, code: 'RATE_LIMITED', message: 'Rate limited.' }),
      ok({ error: true, code: 'NOT_FOUND', message: 'No such notebook.' }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const limited = await provider.listNotebooks();
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.failure.kind).toBe('rate_limited');

    const rejected = await provider.createNotebook('x');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.failure.kind).toBe('rejected');
  });

  it('keeps the diagnostics of the CLI out of the answer', async () => {
    const { runner } = fakeRunner([
      {
        code: 1,
        stdout: '',
        stderr: 'Error: something went wrong',
        timedOut: false,
      },
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.listNotebooks();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('rejected');
      expect(outcome.failure.message).toMatch(/something went wrong/);
    }
  });

  it('reports a source that the CLI added only partly', async () => {
    const { runner } = fakeRunner([
      ok({
        source: { id: 's1', title: 'Article', type: 'url', url: 'https://example.com' },
        fallback: { error: 'the page was fetched as text' },
      }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.addSource('nb1', 'https://example.com');

    // The fallback is a detail of the upstream: the source itself is there.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.id).toBe('s1');
    }
  });

  it('gives the deadline of the operation to the runner', async () => {
    const { runner, calls } = fakeRunner([ok({ answer: 'yes' })]);
    const provider = createNotebookLmProvider({ runner, timeoutMs: 1000 });

    await provider.ask('nb1', 'hello');

    expect(calls[0]?.timeoutMs).toBe(1000);
  });

  it('reports a mutation that answered with garbage as a failure that may have run', async () => {
    const { runner } = fakeRunner([ok({ notebook: { title: 'no id' } })]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.createNotebook('Notes');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('invalid_output');
      // The notebook may have been created: it must not be created again blind.
      expect(outcome.failure.mayHaveRun).toBe(true);
    }
  });

  it('reports a mutation that failed with an unknown state as a failure that may have run', async () => {
    const { runner } = fakeRunner([
      ok({ error: true, code: 'NETWORK_ERROR', message: 'The network went away.' }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.addSource('nb1', 'https://example.com');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('unavailable');
      expect(outcome.failure.mayHaveRun).toBe(true);
    }
  });

  it('does not mark a refusal that never reached the server as a failure that may have run', async () => {
    const { runner } = fakeRunner([
      ok({ error: true, code: 'AUTH_ERROR', message: 'Authentication error: expired' }),
    ]);
    const provider = createNotebookLmProvider({ runner });

    const outcome = await provider.createNotebook('Notes');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('unauthorized');
      // The notebook was never created: the operation can be sent again.
      expect(outcome.failure.mayHaveRun).toBeUndefined();
    }
  });
});

describe('the registry of the knowledge providers', () => {
  it('resolves the provider of the command', () => {
    resetKnowledgeProviders();

    const provider = getKnowledgeProvider(NOTEBOOKLM_PROVIDER_NAME);

    expect(provider.name).toBe(NOTEBOOKLM_PROVIDER_NAME);
    expect(listKnowledgeProviders()).toContain(NOTEBOOKLM_PROVIDER_NAME);
  });

  it('lets a caller replace a provider', () => {
    resetKnowledgeProviders();

    registerKnowledgeProvider('fake', () => ({ name: 'fake' }) as KnowledgeProvider);

    expect(getKnowledgeProvider('fake').name).toBe('fake');
    resetKnowledgeProviders();
  });

  it('throws for an unknown provider', () => {
    resetKnowledgeProviders();

    expect(() => getKnowledgeProvider('nope')).toThrow(/Unknown knowledge provider/);
  });
});
