import chalk from 'chalk';
import { Command } from 'commander';
import { getBackend, listBackends, providerOfBackend } from '../backend/index.js';
import { runReviewPipeline } from '../pipeline/review.js';

export function createReviewCommand(): Command {
  const cmd = new Command('review')
    .description(
      'Run a review pipeline over a pull request, a branch or a diff — the pipeline never publishes to GitHub',
    )
    .option('--pr <number>', 'The pull request to review (the metadata comes from the gh CLI)')
    .option('--base <ref>', 'The base of the comparison (default: the default branch of origin)')
    .option('--head <ref>', 'The head of the comparison (default: HEAD)')
    .option('--backend <name>', 'The backend that answers (default: chatgpt-use)')
    .option('--model <name>', 'The model the reviewers use')
    .option('--timeout <ms>', 'The timeout of a request, in milliseconds')
    .option('--out <file>', 'Write the report to a file as well')
    .action(async (options) => {
      const backendName = (options.backend as string | undefined) ?? 'chatgpt-use';
      const available = listBackends().filter((name) => !getBackend(name).testDouble);
      if (!available.includes(backendName)) {
        console.error(
          chalk.red(
            `Unknown backend: ${backendName}. Available: ${available.join(', ') || 'none'}`,
          ),
        );
        process.exit(1);
      }

      const timeoutMs = (() => {
        if (options.timeout === undefined) return undefined;
        const value = Number.parseInt(options.timeout as string, 10);
        if (!Number.isFinite(value) || value <= 0) {
          console.error(
            chalk.red(`Invalid --timeout value: ${options.timeout} (expected a positive integer)`),
          );
          process.exit(1);
        }
        return value;
      })();

      const pr = (() => {
        if (options.pr === undefined) return undefined;
        const value = Number.parseInt(options.pr as string, 10);
        if (!Number.isFinite(value) || value <= 0) {
          console.error(chalk.red(`Invalid --pr value: ${options.pr} (expected a number)`));
          process.exit(1);
        }
        return value;
      })();

      const backend = getBackend(backendName);
      const provider = providerOfBackend(backendName);

      try {
        const run = await runReviewPipeline({
          backend,
          target: {
            cwd: process.cwd(),
            ...(pr !== undefined ? { pr } : {}),
            ...(options.base ? { base: options.base as string } : {}),
            ...(options.head ? { head: options.head as string } : {}),
          },
          ...(options.model ? { model: options.model as string } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          backendLabel: provider ? `${backendName} (${provider})` : backendName,
        });

        console.log(run.report);
        console.log(chalk.dim(`Run: ${run.id}`));

        if (options.out) {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(options.out as string, run.report, 'utf-8');
          console.log(chalk.dim(`Report: ${options.out}`));
        }

        // A review that could not collect its context, or whose reviewer or
        // verification did not run, is a failed review — not a review with
        // nothing to say.
        const incomplete = run.steps.find(
          (step) => step.id !== 'render-report' && step.status !== 'passed',
        );
        if (incomplete) {
          console.error(
            chalk.red(
              `The review is incomplete: ${incomplete.id} — ${incomplete.detail ?? incomplete.status}`,
            ),
          );
          process.exit(1);
        }
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    });

  return cmd;
}
