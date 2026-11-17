import chalk from 'chalk';
import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';
import { getConfigPath } from '../paths.js';
import { isValidProvider, listProviders } from '../providers/index.js';
import type { ProviderName } from '../types.js';

/** `profile-mode`, `profileMode` and `profilemode` all mean the same key. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, '');
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('View or modify configuration');

  cmd
    .command('show')
    .description('Show current configuration')
    .action(async () => {
      const config = await loadConfig();
      console.log(chalk.bold('Current Configuration\n'));
      console.log(`  ${chalk.dim('file:')} ${getConfigPath()}`);
      console.log();
      console.log(JSON.stringify(config, null, 2));
    });

  cmd
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key (provider, model, timeout, headless, profile-mode)')
    .argument('<value>', 'Configuration value')
    .action(async (key: string, value: string) => {
      const config = await loadConfig();
      const name = normalizeKey(key);

      switch (name) {
        case 'provider':
          if (!isValidProvider(value)) {
            console.error(
              chalk.red(`Invalid provider: ${value} (available: ${listProviders().join(', ')})`),
            );
            process.exit(1);
          }
          config.defaultProvider = value as ProviderName;
          break;
        case 'model':
          config.defaultModel = value;
          break;
        case 'timeout': {
          const timeoutMs = Number.parseInt(value, 10);
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            console.error(
              chalk.red(`Invalid timeout: ${value} (expected a positive integer in ms)`),
            );
            process.exit(1);
          }
          config.defaultTimeoutMs = timeoutMs;
          break;
        }
        case 'headless':
          if (value !== 'true' && value !== 'false') {
            console.error(
              chalk.red(`Invalid headless value: ${value} (expected 'true' or 'false')`),
            );
            process.exit(1);
          }
          config.headless = value === 'true';
          break;
        case 'profilemode':
          if (value !== 'shared' && value !== 'isolated') {
            console.error(
              chalk.red(`Invalid profile mode: ${value} (expected 'shared' or 'isolated')`),
            );
            process.exit(1);
          }
          config.profileMode = value;
          break;
        default:
          console.error(chalk.red(`Unknown config key: ${key}`));
          console.log(
            chalk.dim('Available keys: provider, model, timeout, headless, profile-mode'),
          );
          process.exit(1);
      }

      await saveConfig(config);
      console.log(chalk.green(`✓ Set ${key} = ${value}`));
    });

  return cmd;
}
