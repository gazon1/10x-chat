import chalk from 'chalk';
import { Command } from 'commander';
import { getBackend, listBackends, providerOfBackend } from '../backend/index.js';
import { OrcaClient } from '../orca/client.js';
import {
  createWorkflowContext,
  renderWorkflowReport,
  resumeWorkflow,
  startWorkflow,
  stopWorkflow,
  WorkflowError,
} from '../workflow/orchestrator.js';
import { loadWorkflow } from '../workflow/store.js';

/**
 * The command of the development workflow.
 *
 * The workflow automates the loop of the Helix playbook: the Issue, an
 * isolated worktree, a coding agent, an independent review, the findings back
 * to the agent — until the review approves the change or the workflow blocks.
 */

/** A positive integer of the command line — the whole argument, or nothing. */
function positiveInteger(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The backend that reviews the change — the one the review command uses. */
function resolveBackend(name: string | undefined) {
  const backendName = name ?? 'chatgpt-use';
  const available = listBackends().filter((candidate) => !getBackend(candidate).testDouble);
  if (!available.includes(backendName)) {
    throw new WorkflowError(
      `Unknown backend: ${backendName}. Available: ${available.join(', ') || 'none'}`,
    );
  }
  return {
    backend: getBackend(backendName),
    label: providerOfBackend(backendName)
      ? `${backendName} (${providerOfBackend(backendName)})`
      : backendName,
  };
}

/**
 * The backend and the model of a resume.
 *
 * A workflow that was reviewed by one backend is resumed with the same one:
 * the review of the next iteration has to be the review of the same kind, and
 * a backend that is silently another one is a review nobody asked for. The
 * command line still wins — the user may change the model on purpose.
 */
export function resumeBackendOf(
  record: { backendName?: string; model?: string },
  options: { backend?: string; model?: string },
): { backend: string; model?: string } {
  const name = options.backend ?? record.backendName ?? 'chatgpt-use';
  const available = listBackends().filter((candidate) => !getBackend(candidate).testDouble);
  if (!available.includes(name)) {
    throw new WorkflowError(
      `The backend ${name} of the workflow is not available. Available: ${available.join(', ') || 'none'}. Name another one with --backend.`,
    );
  }
  const model = options.model ?? record.model;
  return { backend: name, ...(model ? { model } : {}) };
}

/**
 * The options of the start — the translation of the command line.
 *
 * The translation is a function of its own: the command line is the boundary
 * of the workflow, and the numbers that it carries have to reach the workflow
 * unchanged.
 */
export function startOptionsOf(options: {
  issue: number;
  agent?: string;
  backend: string;
  model?: string;
  maxIterations?: number;
  base?: string;
  wait?: number;
}): {
  issue: number;
  agent?: string;
  backendName: string;
  model?: string;
  maxIterations?: number;
  baseRef?: string;
  waitTimeoutMs?: number;
} {
  return {
    issue: options.issue,
    ...(options.agent ? { agent: options.agent } : {}),
    backendName: options.backend,
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.base ? { baseRef: options.base } : {}),
    ...(options.wait !== undefined ? { waitTimeoutMs: options.wait } : {}),
  };
}

/** Print the state of a workflow. */
function printState(record: { id: string; state: string; blocked?: string }): void {
  console.log(`${record.id}: ${record.state}`);
  if (record.blocked) console.log(chalk.yellow(record.blocked));
}

export function createWorkflowCommand(): Command {
  const cmd = new Command('workflow').description(
    'Run the development workflow of a GitHub Issue — Orca works in an isolated worktree, the review pipeline judges the change',
  );

  cmd
    .command('start')
    .description('Start the workflow of an Issue of the repository of the checkout')
    .requiredOption('--issue <number>', 'The Issue to implement')
    .option('--agent <id>', 'The Orca agent that implements the change (default: codex)')
    .option('--backend <name>', 'The backend that reviews the change (default: chatgpt-use)')
    .option('--model <name>', 'The model the reviewers use')
    .option('--max-iterations <n>', 'The maximum number of iterations (default: 3)')
    .option(
      '--base <ref>',
      'The ref the worktree is created from (default: the default branch of origin)',
    )
    .option('--wait <ms>', 'How long to wait for the agent before the workflow gives the turn back')
    .action(async (options) => {
      const issue = positiveInteger(options.issue as string);
      if (issue === undefined) {
        console.error(chalk.red(`Invalid --issue value: ${options.issue} (expected a number)`));
        process.exit(1);
      }
      const maxIterations = (() => {
        if (options.maxIterations === undefined) return undefined;
        const value = positiveInteger(options.maxIterations as string);
        if (value === undefined) {
          console.error(
            chalk.red(
              `Invalid --max-iterations value: ${options.maxIterations} (expected a number)`,
            ),
          );
          process.exit(1);
        }
        return value;
      })();
      const wait = (() => {
        if (options.wait === undefined) return undefined;
        const value = positiveInteger(options.wait as string);
        if (value === undefined) {
          console.error(chalk.red(`Invalid --wait value: ${options.wait} (expected a number)`));
          process.exit(1);
        }
        return value;
      })();

      try {
        const { backend, label } = resolveBackend(options.backend as string | undefined);
        const translated = startOptionsOf({
          issue,
          ...(options.agent ? { agent: options.agent as string } : {}),
          backend: (options.backend as string | undefined) ?? 'chatgpt-use',
          ...(options.model ? { model: options.model as string } : {}),
          ...(maxIterations !== undefined ? { maxIterations } : {}),
          ...(options.base ? { base: options.base as string } : {}),
          ...(wait !== undefined ? { wait } : {}),
        });
        const ctx = createWorkflowContext({
          orca: new OrcaClient(),
          backend,
          cwd: process.cwd(),
          backendLabel: label,
          ...(options.model ? { model: options.model as string } : {}),
          ...(wait !== undefined ? { waitTimeoutMs: wait } : {}),
        });
        const record = await startWorkflow(
          {
            issue: translated.issue,
            cwd: process.cwd(),
            backend,
            backendLabel: label,
            backendName: translated.backendName,
            ...(translated.agent ? { agent: translated.agent } : {}),
            ...(translated.model ? { model: translated.model } : {}),
            ...(translated.baseRef ? { baseRef: translated.baseRef } : {}),
            ...(translated.maxIterations !== undefined
              ? { maxIterations: translated.maxIterations }
              : {}),
            ...(translated.waitTimeoutMs !== undefined
              ? { waitTimeoutMs: translated.waitTimeoutMs }
              : {}),
          },
          ctx,
        );
        printState(record);
        if (record.state === 'completed') {
          console.log(chalk.green('The review approved the change.'));
        }
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Show the state of a workflow — it never changes it')
    .argument('<workflow-id>', 'The id of the workflow')
    .action(async (id: string) => {
      try {
        const record = await loadWorkflow(id);
        printState(record);
        console.log(chalk.dim(`Issue: #${record.issue.number} — ${record.issue.title}`));
        console.log(
          chalk.dim(`Iterations: ${record.iterations.length} of ${record.maxIterations}`),
        );
        if (record.worktree) {
          console.log(chalk.dim(`Worktree: ${record.worktree.path} (${record.worktree.branch})`));
        }
        const review = record.iterations[record.iterations.length - 1]?.review;
        if (review) {
          console.log(chalk.dim(`Review: ${review.verdict} — ${review.verdictReason}`));
        }
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  cmd
    .command('resume')
    .description('Continue a workflow that was interrupted')
    .argument('<workflow-id>', 'The id of the workflow')
    .option('--backend <name>', 'The backend that reviews the change (default: chatgpt-use)')
    .option('--model <name>', 'The model the reviewers use')
    .option('--wait <ms>', 'How long to wait for the agent before the workflow gives the turn back')
    .action(async (id: string, options) => {
      try {
        // The record is read before the backend is resolved: a workflow is
        // resumed with the backend and the model it was started with.
        const stored = await loadWorkflow(id);
        const chosen = resumeBackendOf(stored, {
          ...(options.backend ? { backend: options.backend as string } : {}),
          ...(options.model ? { model: options.model as string } : {}),
        });
        const { backend, label } = resolveBackend(chosen.backend);
        const wait = (() => {
          if (options.wait === undefined) return undefined;
          const value = positiveInteger(options.wait as string);
          if (value === undefined) {
            console.error(chalk.red(`Invalid --wait value: ${options.wait} (expected a number)`));
            process.exit(1);
          }
          return value;
        })();
        const ctx = createWorkflowContext({
          orca: new OrcaClient(),
          backend,
          cwd: process.cwd(),
          backendLabel: label,
          ...(chosen.model ? { model: chosen.model } : {}),
          ...(wait !== undefined ? { waitTimeoutMs: wait } : {}),
        });
        const record = await resumeWorkflow(id, ctx);
        printState(record);
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  cmd
    .command('stop')
    .description('Stop a workflow — the state and the worktree stay for the inspection')
    .argument('<workflow-id>', 'The id of the workflow')
    .action(async (id: string) => {
      try {
        const ctx = createWorkflowContext({
          orca: new OrcaClient(),
          cwd: process.cwd(),
        });
        const record = await stopWorkflow(id, ctx);
        printState(record);
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  cmd
    .command('report')
    .description('Show the report of a workflow')
    .argument('<workflow-id>', 'The id of the workflow')
    .action(async (id: string) => {
      try {
        const record = await loadWorkflow(id);
        console.log(renderWorkflowReport(record));
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  return cmd;
}
