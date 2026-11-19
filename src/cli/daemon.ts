import chalk from 'chalk';
import { Command } from 'commander';
import { daemonStatus, requestDaemonStop, restartDaemon } from '../browser/daemon.js';

export function createDaemonCommand(): Command {
  const cmd = new Command('daemon').description('Inspect and control the shared browser daemon');

  cmd
    .command('status')
    .description('Show the state of the shared browser daemon')
    .action(async () => {
      const status = await daemonStatus();

      if (!status.running) {
        console.log(chalk.dim('The browser daemon is not running.'));
        return;
      }

      console.log(chalk.bold('Browser daemon\n'));
      console.log(`  PID:      ${status.pid}`);
      console.log(`  Port:     ${status.port}`);
      console.log(`  Mode:     ${status.headless ? 'headless' : 'headed'}`);
      console.log(
        `  Version:  ${status.version ?? 'unknown'}` +
          (status.upToDate ? '' : chalk.yellow(` (installed: ${status.clientVersion})`)),
      );
      if (status.createdAt) {
        console.log(`  Started:  ${new Date(status.createdAt).toLocaleString()}`);
      }
      console.log(
        `  Sessions: ${status.activeContexts} context(s), ${status.activePages} page(s), ` +
          `${status.pendingCreations} pending`,
      );

      if (!status.healthy) {
        console.log(chalk.yellow('  The daemon does not answer — it is stale.'));
      }
      if (!status.upToDate) {
        console.log(
          chalk.yellow('  The daemon runs another version — run `10x-chat daemon restart`.'),
        );
      }
      if (status.busy) {
        console.log(chalk.yellow('  The daemon has the session of another process.'));
      }
    });

  cmd
    .command('stop')
    .description('Stop the shared browser daemon')
    .option('--force', 'Stop the daemon even when it has the session of another process')
    .option('--if-idle', 'Skip the stop when the daemon has the session of another process')
    .action(async (options: { force?: boolean; ifIdle?: boolean }) => {
      const outcome = await requestDaemonStop({ force: options.force });

      if (outcome === 'not-running') {
        console.log(chalk.dim('The browser daemon is not running.'));
        return;
      }

      if (outcome === 'refused') {
        // The daemon did not confirm that it is idle: it may still serve the
        // session of another process, so it is left running.
        if (options.ifIdle) {
          console.log(
            chalk.dim(
              'The browser daemon did not confirm that it is idle — left running. ' +
                'Run `10x-chat daemon restart` when the other session is finished.',
            ),
          );
          return;
        }
        console.error(
          chalk.red(
            'The browser daemon did not confirm that it is idle and was not stopped. ' +
              'Wait for the other session to finish, or pass --force.',
          ),
        );
        process.exit(1);
      }

      if (outcome === 'busy') {
        if (options.ifIdle) {
          console.log(
            chalk.dim(
              'The browser daemon has the session of another process — left running. ' +
                'Run `10x-chat daemon restart` when that session is finished.',
            ),
          );
          return;
        }
        console.error(
          chalk.red(
            'The browser daemon has the session of another process and was not stopped. ' +
              'Wait for that session to finish, or pass --force.',
          ),
        );
        process.exit(1);
      }

      console.log(chalk.green('✓ Browser daemon stopped.'));
    });

  cmd
    .command('restart')
    .description('Replace the shared browser daemon with a new one')
    .option('--force', 'Replace the daemon even when it has the session of another process')
    .action(async (options: { force?: boolean }) => {
      try {
        const status = await restartDaemon({ force: options.force });
        console.log(
          chalk.green(`✓ Browser daemon restarted (pid ${status.pid}, version ${status.version}).`),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
        process.exit(1);
      }
    });

  return cmd;
}
