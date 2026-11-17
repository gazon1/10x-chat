import chalk from 'chalk';
import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';
import { getConfigPath } from '../paths.js';
import { isValidProvider, listProviders } from '../providers/index.js';
import { CREDENTIAL_STORAGE_VALUES, getSecretStore, redactSecretValues } from '../secrets.js';
import type { CredentialStorage, ProviderName } from '../types.js';

/** `profile-mode`, `profileMode` and `profilemode` all mean the same key. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, '');
}

/** The values of every stored secret — used to redact them from the output. */
async function storedSecretValues(): Promise<string[]> {
  const store = getSecretStore();
  const names = await store.list();
  const values = await Promise.all(names.map((name) => store.get(name)));
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * Check that a secret exists — a config file may only refer to a secret that
 * is stored.
 */
async function assertSecretExists(name: string): Promise<void> {
  const store = getSecretStore();
  if ((await store.get(name)) === undefined) {
    throw new Error(`No secret named "${name}". Create it with: 10x-chat secrets set ${name}`);
  }
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('View or modify configuration');

  cmd
    .command('show')
    .description('Show current configuration')
    .action(async () => {
      const config = await loadConfig({ checkSecrets: false });
      console.log(chalk.bold('Current Configuration\n'));
      console.log(`  ${chalk.dim('file:')} ${getConfigPath()}`);
      console.log();
      // The config file holds references, not values — but a secret that
      // leaked into a value must not reach the terminal either.
      const text = redactSecretValues(JSON.stringify(config, null, 2), await storedSecretValues());
      console.log(text);
    });

  cmd
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key (provider, model, timeout, headless, profile-mode)')
    .argument('<value>', 'Configuration value')
    .argument('[secret]', 'Name of the secret (for provider-key)')
    .action(async (key: string, value: string, secret?: string) => {
      const config = await loadConfig({ checkSecrets: false });
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
        case 'credentialstorage':
          if (!(CREDENTIAL_STORAGE_VALUES as readonly string[]).includes(value)) {
            console.error(
              chalk.red(
                `Invalid credential storage: ${value} (expected ${CREDENTIAL_STORAGE_VALUES.join(', ')})`,
              ),
            );
            process.exit(1);
          }
          config.credentialStorage = value as CredentialStorage;
          break;
        case 'providerkey': {
          if (!secret) {
            console.error(
              chalk.red('Usage: 10x-chat config set provider-key <provider> <secret-name>'),
            );
            process.exit(1);
          }
          if (!isValidProvider(value)) {
            console.error(
              chalk.red(`Invalid provider: ${value} (available: ${listProviders().join(', ')})`),
            );
            process.exit(1);
          }
          await assertSecretExists(secret);
          config.providerKeys = { ...config.providerKeys, [value]: secret };
          break;
        }
        case 'proxysecret':
          console.error(
            chalk.red(
              'The key "proxy-secret" is gone: the proxy is configured in the config file ' +
                '(the section "proxy") and its credentials are two secrets of the store ' +
                '("proxy.username" and "proxy.password").',
            ),
          );
          process.exit(1);
          break;
        default:
          console.error(chalk.red(`Unknown config key: ${key}`));
          console.log(
            chalk.dim(
              'Available keys: provider, model, timeout, headless, profile-mode, provider-key, credential-storage',
            ),
          );
          process.exit(1);
      }

      await saveConfig(config);
      console.log(chalk.green(`✓ Set ${key} = ${value}`));
    });

  cmd
    .command('unset')
    .description('Remove a configuration value')
    .argument('<key>', 'Configuration key (provider-key)')
    .argument('[value]', 'Provider (for provider-key)')
    .action(async (key: string, value?: string) => {
      const config = await loadConfig({ checkSecrets: false });

      switch (normalizeKey(key)) {
        case 'providerkey': {
          if (!value) {
            console.error(chalk.red('Usage: 10x-chat config unset provider-key <provider>'));
            process.exit(1);
          }
          if (!isValidProvider(value)) {
            console.error(
              chalk.red(`Invalid provider: ${value} (available: ${listProviders().join(', ')})`),
            );
            process.exit(1);
          }
          const providerKeys = { ...config.providerKeys };
          if (!providerKeys[value as ProviderName]) {
            console.error(chalk.red(`No API key is configured for provider "${value}"`));
            process.exit(1);
          }
          delete providerKeys[value as ProviderName];
          if (Object.keys(providerKeys).length > 0) {
            config.providerKeys = providerKeys;
          } else {
            delete config.providerKeys;
          }
          break;
        }
        case 'credentialstorage':
          delete config.credentialStorage;
          break;
        case 'proxysecret':
          console.error(
            chalk.red(
              'The key "proxy-secret" is gone: the proxy is configured in the config file ' +
                '(the section "proxy").',
            ),
          );
          process.exit(1);
          break;
        default:
          console.error(chalk.red(`Unknown config key: ${key}`));
          console.log(chalk.dim('Available keys: provider-key, credential-storage'));
          process.exit(1);
      }

      await saveConfig(config);
      console.log(chalk.green(`✓ Unset ${key}`));
    });

  return cmd;
}
