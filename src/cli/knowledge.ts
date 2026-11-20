import chalk from 'chalk';
import { Command } from 'commander';
import type {
  KnowledgeFailure,
  KnowledgeNotebook,
  KnowledgeOutcome,
  KnowledgeProvider,
  KnowledgeSource,
  KnowledgeStatus,
} from '../knowledge/contract.js';
import { createNotebookLmProvider } from '../knowledge/notebooklm.js';

/** The version of the JSON contract of the commands. */
const SCHEMA = '10x-chat/knowledge/v1';

/** The options every operation of the group takes. */
interface CommonOptions {
  json?: boolean;
  profile?: string;
  timeout?: string;
}

/** The deadline of an operation — the default of the provider when it is not given. */
function timeoutOf(options: CommonOptions): number | undefined {
  if (options.timeout === undefined) return undefined;
  const value = Number.parseInt(options.timeout, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --timeout value: ${options.timeout} (expected a positive integer)`);
  }
  return value;
}

/** The options of every leaf of the group. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option('--json', 'Machine-readable output')
    .option('--profile <name>', 'The profile of notebooklm-py to use')
    .option('--timeout <ms>', 'The deadline of the operation in milliseconds');
}

/** What the user can do about a failure. */
function hintFor(failure: KnowledgeFailure): string {
  switch (failure.kind) {
    case 'unavailable':
      return 'The notebooklm CLI is not installed or cannot be started. Install it with: pipx install notebooklm-py';
    case 'unauthorized':
      return 'Not logged in to NotebookLM. Log in with: notebooklm login';
    case 'timeout':
      return 'The provider did not answer in time.';
    case 'cancelled':
      return 'The operation was cancelled.';
    case 'rate_limited':
      return 'The provider is rate limited — try again later.';
    case 'invalid_output':
      return 'The answer of the provider was not usable.';
    case 'rejected':
      return 'The provider refused the operation.';
  }
}

/**
 * Run an operation and print its result.
 *
 * With `--json` the stdout is the envelope of the operation and nothing else:
 * the diagnostics of the provider stay on its stderr, and the exit code says
 * that the operation failed.
 */
async function execute<T>(
  operation: string,
  options: CommonOptions,
  action: (provider: KnowledgeProvider) => Promise<KnowledgeOutcome<T>>,
  renderText: (value: T) => string,
): Promise<KnowledgeOutcome<T> | undefined> {
  let timeoutMs: number | undefined;
  try {
    timeoutMs = timeoutOf(options);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }
  const provider = createNotebookLmProvider({
    ...(options.profile ? { profile: options.profile } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const outcome = await action(provider);
  if (outcome.ok) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            schema: SCHEMA,
            provider: provider.name,
            operation,
            ok: true,
            data: outcome.value,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(renderText(outcome.value));
    }
    return outcome;
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          schema: SCHEMA,
          provider: provider.name,
          operation,
          ok: false,
          error: outcome.failure,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(chalk.red(outcome.failure.message));
    const hint = hintFor(outcome.failure);
    console.error(
      chalk.yellow(
        outcome.failure.mayHaveRun
          ? `${hint} The operation may have run — do not send it again.`
          : hint,
      ),
    );
  }
  process.exitCode = 1;
  return outcome;
}

/** The text of a list of notebooks. */
function renderNotebooks(notebooks: KnowledgeNotebook[]): string {
  if (notebooks.length === 0) return chalk.dim('No notebooks.');
  return notebooks.map((notebook) => `${chalk.cyan(notebook.id)}  ${notebook.title}`).join('\n');
}

/** The text of a list of sources. */
function renderSources(sources: KnowledgeSource[]): string {
  if (sources.length === 0) return chalk.dim('No sources.');
  return sources
    .map((source) => {
      const status = source.status ? chalk.dim(` [${source.status}]`) : '';
      return `${chalk.cyan(source.id)}  ${source.title}${status}`;
    })
    .join('\n');
}

/** The text of the state of the provider. */
function renderStatus(status: KnowledgeStatus): string {
  const lines = [
    `Available:     ${status.available ? chalk.green('yes') : chalk.red('no')}`,
    `Authenticated: ${status.authenticated ? chalk.green('yes') : chalk.red('no')}`,
  ];
  if (status.profile) lines.push(`Profile:       ${status.profile}`);
  if (status.message) lines.push(chalk.dim(status.message));
  return lines.join('\n');
}

/** The command group of the knowledge providers. */
export function createKnowledgeCommand(): Command {
  const cmd = new Command('knowledge').description(
    'NotebookLM as a knowledge provider — notebooks, sources and grounded answers',
  );

  cmd.addCommand(
    withCommonOptions(
      new Command('status').description('Is the provider installed, and is it logged in?'),
    ).action(async (options: CommonOptions) => {
      const outcome = await execute(
        'status',
        options,
        (provider) => provider.status(),
        renderStatus,
      );
      // A provider that is not logged in is not ready: the command reports it
      // and the exit code says so, like `gh auth status` does.
      if (outcome?.ok && !outcome.value.authenticated) {
        process.exitCode = 1;
      }
    }),
  );

  const notebooks = new Command('notebooks').description('The notebooks of the provider');
  notebooks.addCommand(
    withCommonOptions(new Command('list').description('List the notebooks')).action(
      async (options: CommonOptions) => {
        await execute(
          'notebooks.list',
          options,
          (provider) => provider.listNotebooks(),
          renderNotebooks,
        );
      },
    ),
  );
  notebooks.addCommand(
    withCommonOptions(
      new Command('create')
        .description('Create a notebook')
        .requiredOption('--title <title>', 'The title of the notebook'),
    ).action(async (options: CommonOptions & { title: string }) => {
      await execute(
        'notebooks.create',
        options,
        (provider) => provider.createNotebook(options.title),
        (notebook) => `Created notebook ${chalk.cyan(notebook.id)} ${notebook.title}`,
      );
    }),
  );
  cmd.addCommand(notebooks);

  const sources = new Command('sources').description('The sources of a notebook');
  sources.addCommand(
    withCommonOptions(
      new Command('add')
        .description('Add a source to a notebook')
        .requiredOption('--notebook <id>', 'The notebook of the source')
        .requiredOption('--url <url>', 'The URL of the source'),
    ).action(async (options: CommonOptions & { notebook: string; url: string }) => {
      await execute(
        'sources.add',
        options,
        (provider) => provider.addSource(options.notebook, options.url),
        (source) => `Added source ${chalk.cyan(source.id)} ${source.title}`,
      );
    }),
  );
  sources.addCommand(
    withCommonOptions(
      new Command('list')
        .description('List the sources of a notebook')
        .requiredOption('--notebook <id>', 'The notebook of the sources'),
    ).action(async (options: CommonOptions & { notebook: string }) => {
      await execute(
        'sources.list',
        options,
        (provider) => provider.listSources(options.notebook),
        renderSources,
      );
    }),
  );
  sources.addCommand(
    withCommonOptions(
      new Command('refresh')
        .description('Refresh a source of a notebook')
        .requiredOption('--notebook <id>', 'The notebook of the source')
        .requiredOption('--source <id>', 'The source to refresh'),
    ).action(async (options: CommonOptions & { notebook: string; source: string }) => {
      await execute(
        'sources.refresh',
        options,
        (provider) => provider.refreshSource(options.notebook, options.source),
        (source) => `Refreshed source ${chalk.cyan(source.id)} ${source.title}`,
      );
    }),
  );
  cmd.addCommand(sources);

  cmd.addCommand(
    withCommonOptions(
      new Command('ask')
        .description('Ask a question about a notebook')
        .requiredOption('--notebook <id>', 'The notebook to ask')
        .requiredOption('--question <text>', 'The question')
        .option(
          '--source <id>',
          'Limit the answer to a source (repeatable)',
          (value: string, previous: string[] = []) => [...previous, value],
        ),
    ).action(
      async (
        options: CommonOptions & { notebook: string; question: string; source?: string[] },
      ) => {
        await execute(
          'ask',
          options,
          (provider) =>
            provider.ask(options.notebook, options.question, { sources: options.source ?? [] }),
          (answer) => answer.answer,
        );
      },
    ),
  );

  return cmd;
}
