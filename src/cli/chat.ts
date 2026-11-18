import chalk from 'chalk';
import { Command } from 'commander';
import { buildBundle } from '../core/bundle.js';
import {
  type ChatAllResult,
  type ChatResult,
  failureHint,
  printFailureHint,
  runChat,
  runChatAll,
} from '../core/index.js';
import { isValidProvider } from '../providers/index.js';
import type { ProviderName, TransportName } from '../types.js';

const DIVIDER = chalk.dim('─'.repeat(60));

export function createChatCommand(): Command {
  const cmd = new Command('chat')
    .description('Chat with an AI provider via browser automation')
    .requiredOption('-p, --prompt <text>', 'The prompt to send')
    .option(
      '--provider <name>',
      'Provider to use (chatgpt, gemini, claude, grok, perplexity, deepseek)',
    )
    .option(
      '--all',
      'Send to all chat providers in parallel via browser and compare responses (browser transport only)',
    )
    .option('--model <name>', 'Model to select')
    .option('-f, --file <paths...>', 'Files/globs to include as context')
    .option('-a, --attach <paths...>', 'Images/files to upload as attachments')
    .option('--copy', 'Copy the bundle to clipboard instead of sending')
    .option('--dry-run', 'Preview the bundle without sending')
    .option('--headed', 'Show browser window during chat')
    .option('--headless', 'Force headless browser even for providers that prefer headed')
    .option('--timeout <ms>', 'Response timeout in milliseconds (overrides the config)')
    .option('--transport <name>', 'Transport to use: browser (default) or api (requires --provider)')
    .option(
      '--new-chat',
      'Start a new conversation instead of reusing the one stored for this repo/branch',
    )
    .option('--save-images <dir>', 'Save generated images to directory')
    .option('--profile <name>', 'Use named browser profile')
    .option('--isolated-profile', 'Use per-provider browser profiles (backward compat)')
    .action(async (options) => {
      const provider = options.provider as string | undefined;
      if (provider && !isValidProvider(provider)) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        process.exit(1);
      }
      if (options.all && provider) {
        console.error(chalk.red('Cannot use --all and --provider together. Pick one.'));
        process.exit(1);
      }
      if (options.headed && options.headless) {
        console.error(chalk.red('Cannot use --headed and --headless together.'));
        process.exit(1);
      }

      const transport = options.transport as string | undefined;
      if (transport && transport !== 'browser' && transport !== 'api') {
        console.error(
          chalk.red(`Invalid --transport value: ${transport} (expected "browser" or "api")`),
        );
        process.exit(1);
      }
      if (options.all && transport === 'api') {
        console.error(
          chalk.red(
            'Cannot use --all with --transport api: API calls are billed per request and providers support different transports. Specify --provider <name>.',
          ),
        );
        process.exit(1);
      }

      const timeoutMs = (() => {
        if (options.timeout === undefined) return undefined;
        const t = Number.parseInt(options.timeout, 10);
        if (!Number.isFinite(t) || t <= 0) {
          console.error(
            chalk.red(`Invalid --timeout value: ${options.timeout} (expected a positive integer)`),
          );
          process.exit(1);
        }
        return t;
      })();

      const commonOpts = {
        prompt: options.prompt,
        model: options.model,
        file: options.file,
        attach: options.attach,
        headed: options.headed,
        headless: options.headless,
        saveImages: options.saveImages,
        isolatedProfile: options.isolatedProfile,
        profile: options.profile,
        timeoutMs,
        transport: transport as TransportName | undefined,
        newChat: options.newChat === true,
      };

      // Dry run: just show the bundle
      if (options.dryRun) {
        const bundle = await buildBundle({ prompt: options.prompt, files: options.file });
        console.log(chalk.bold('--- Bundle Preview ---\n'));
        console.log(bundle);
        console.log(chalk.bold('\n--- End Preview ---'));
        return;
      }

      // Copy to clipboard
      if (options.copy) {
        const bundle = await buildBundle({ prompt: options.prompt, files: options.file });
        const { default: clipboardy } = await import('clipboardy');
        await clipboardy.write(bundle);
        console.log(chalk.green('✓ Bundle copied to clipboard'));
        console.log(chalk.dim(`${bundle.length} characters`));
        return;
      }

      // ── All providers ──────────────────────────────────────────
      if (options.all) {
        try {
          const results = await runChatAll(commonOpts);
          renderChatAllResult(results, transport as TransportName | undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
        return;
      }

      // ── Single provider ────────────────────────────────────────
      try {
        const result = await runChat({
          ...commonOpts,
          provider: provider as ProviderName | undefined,
        });

        renderChatResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        printFailureHint(error, transport as TransportName | undefined);
        process.exit(1);
      }
    });

  return cmd;
}

function renderChatAllResult(results: ChatAllResult[], transport?: TransportName): void {
  console.log('\n');
  console.log(chalk.bold.blue('═'.repeat(60)));
  console.log(chalk.bold.blue('  RESPONSES'));
  console.log(chalk.bold.blue('═'.repeat(60)));

  for (const r of results) {
    console.log('');
    if (r.result) {
      console.log(chalk.bold.green(`▶ ${r.provider.toUpperCase()}`));
      console.log(DIVIDER);
      console.log(r.result.response);
      console.log(DIVIDER);
      console.log(
        chalk.dim(
          `  Session: ${r.result.sessionId}  |  ${Math.round(r.result.durationMs / 1000)}s${r.result.conversationId ? `  |  Chat: ${r.result.conversationId}` : ''}${r.result.truncated ? '  ⚠ truncated' : ''}`,
        ),
      );
    } else {
      console.log(chalk.bold.red(`▶ ${r.provider.toUpperCase()} — FAILED`));
      console.log(chalk.red(`  ${r.error}`));
      if (r.kind) console.log(chalk.yellow(`  Hint: ${failureHint(r.kind, transport)}`));
    }
  }
  console.log('');
}

function renderChatResult(result: ChatResult): void {
  console.log('');
  console.log(chalk.bold.green('--- Response ---\n'));
  console.log(result.response);
  console.log('');
  if (result.images && result.images.length > 0) {
    console.log(chalk.bold.green('\n--- Generated Images ---\n'));
    for (const img of result.images) {
      if (img.localPath) {
        console.log(chalk.green(`  🖼 ${img.localPath}`));
      } else {
        console.log(chalk.dim(`  🔗 ${img.url?.slice(0, 100)}`));
      }
    }
  }

  console.log('');
  console.log(chalk.dim(`Session: ${result.sessionId}`));
  if (result.conversationId) {
    console.log(chalk.dim(`Chat: ${result.conversationId}`));
  }
  console.log(chalk.dim(`Duration: ${Math.round(result.durationMs / 1000)}s`));
  if (result.truncated) {
    console.log(chalk.yellow('⚠ Response may be truncated (timeout reached)'));
  }
}
