import chalk from 'chalk';
import { Command } from 'commander';
import { proxyFromEnv, splitProxyCredentials } from '../browser/proxy.js';
import { loadConfig, saveConfig } from '../config.js';
import { getConfigPath } from '../paths.js';
import { getApiTransport } from '../providers/api/registry.js';
import { isValidProvider, listProviders } from '../providers/index.js';
import {
  CREDENTIAL_STORAGE_VALUES,
  getSecretStore,
  PROXY_PASSWORD_SECRET,
  PROXY_USERNAME_SECRET,
  redactSecretValues,
} from '../secrets.js';
import type { AppConfig, CredentialStorage, ProviderName } from '../types.js';

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

/** Check that a secret exists — a config file may only refer to a stored secret. */
async function assertSecretExists(name: string): Promise<void> {
  const store = getSecretStore();
  if ((await store.get(name)) === undefined) {
    throw new Error(`No secret named "${name}". Create it with: 10x-chat secrets set ${name}`);
  }
}

function parseBypass(value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

async function printEffective(config: AppConfig): Promise<void> {
  const store = getSecretStore();
  const names = await store.list();
  const has = (name: string) => names.includes(name);

  console.log();
  console.log(chalk.bold('Effective (non-secret)\n'));

  // Proxy (effective source + state, never credential values)
  if (config.proxy) {
    if (config.proxy.enabled) {
      const server = config.proxy.server ?? '(missing server)';
      const bypass = config.proxy.bypass?.length ? ` bypass=${config.proxy.bypass.join(',')}` : '';
      const user = has(PROXY_USERNAME_SECRET) ? 'configured' : 'not set';
      const pass = has(PROXY_PASSWORD_SECRET) ? 'configured' : 'not set';
      console.log(
        `  proxy: config (enabled) server=${server}${bypass} credentials: username=${user}, password=${pass}`,
      );
    } else {
      console.log('  proxy: disabled in config (environment ignored)');
    }
  } else {
    const env = proxyFromEnv(process.env);
    console.log(`  proxy: ${env ? `environment (${env.server})` : 'none'}`);
  }

  // Provider secret references + transport capability
  const refs = Object.entries(config.providerKeys ?? {}) as [ProviderName, string][];
  if (refs.length > 0) {
    console.log('  providerKeys:');
    for (const [provider, secret] of refs.sort(([a], [b]) => a.localeCompare(b))) {
      const state = has(secret) ? chalk.green('configured') : chalk.red(`missing secret "${secret}"`);
      const transports = getApiTransport(provider) ? 'browser, api' : 'browser';
      console.log(`    ${provider}: secret=${secret} [${state}] transports=${transports}`);
    }
  } else {
    console.log('  providerKeys: (none)');
  }

  console.log(`  credentialStorage: config=${config.credentialStorage ?? 'auto'} actual=${await store.location()}`);
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('View or modify configuration');

  cmd
    .command('show')
    .description('Show stored configuration and effective non-secret state')
    .action(async () => {
      const config = await loadConfig({ checkSecrets: false });
      console.log(chalk.bold('Current Configuration\n'));
      console.log(`  ${chalk.dim('file:')} ${getConfigPath()}`);
      console.log();
      // The config file holds references, not values — but a secret that
      // leaked into a value must not reach the terminal either.
      const text = redactSecretValues(JSON.stringify(config, null, 2), await storedSecretValues());
      console.log(text);
      await printEffective(config);
    });

  cmd
    .command('set')
    .description('Set a configuration value')
    .argument(
      '<key>',
      'Configuration key (provider, model, timeout, headless, profile-mode, provider-key, credential-storage)',
    )
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
              'The key "proxy-secret" is gone: configure the proxy with "10x-chat config proxy set <server>" ' +
                'and store its credentials as secrets "proxy.username" and "proxy.password".',
            ),
          );
          process.exit(1);
          break;
        default:
          console.error(chalk.red(`Unknown config key: ${key}`));
          console.log(
            chalk.dim(
              'Available keys: provider, model, timeout, headless, profile-mode, provider-key, credential-storage. ' +
                'Use "10x-chat config proxy ..." for proxy settings.',
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
    .argument('<key>', 'Configuration key (provider-key, credential-storage, proxy)')
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
        case 'proxy':
          delete config.proxy;
          break;
        case 'proxysecret':
          console.error(
            chalk.red('The key "proxy-secret" is gone: clear the proxy with "10x-chat config proxy clear".'),
          );
          process.exit(1);
          break;
        default:
          console.error(chalk.red(`Unknown config key: ${key}`));
          console.log(chalk.dim('Available keys: provider-key, credential-storage, proxy'));
          process.exit(1);
      }

      await saveConfig(config);
      console.log(chalk.green(`✓ Unset ${key}`));
    });

  // Proxy settings: configure/disable/clear without editing the config file by hand.
  const proxy = cmd.command('proxy').description('Configure, disable, or clear the browser proxy');

  proxy
    .command('set')
    .description('Configure and enable the proxy (credentials go in the secrets store)')
    .argument('<server>', 'Proxy URL without credentials, e.g. http://proxy.example:3128')
    .option('--bypass <hosts>', 'Comma-separated hosts that bypass the proxy')
    .action(async (server: string, options: { bypass?: string }) => {
      if (server.includes('@') || splitProxyCredentials(server).username || splitProxyCredentials(server).password) {
        console.error(
          chalk.red(
            'The proxy URL must not contain credentials. Store them with: 10x-chat secrets set proxy.username && 10x-chat secrets set proxy.password',
          ),
        );
        process.exit(1);
      }
      const config = await loadConfig({ checkSecrets: false });
      const bypass = options.bypass !== undefined ? parseBypass(options.bypass) : config.proxy?.bypass;
      config.proxy = { enabled: true, server: server.trim(), ...(bypass?.length ? { bypass } : {}) };
      await saveConfig(config);
      console.log(chalk.green(`✓ Proxy enabled: ${config.proxy.server}`));
      console.log(
        chalk.dim(
          'Credentials (if needed): 10x-chat secrets set proxy.username && 10x-chat secrets set proxy.password',
        ),
      );
    });

  proxy
    .command('disable')
    .description('Disable the proxy without removing its settings (environment is ignored)')
    .action(async () => {
      const config = await loadConfig({ checkSecrets: false });
      config.proxy = config.proxy ? { ...config.proxy, enabled: false } : { enabled: false };
      await saveConfig(config);
      console.log(chalk.green('✓ Proxy disabled (environment fallback suppressed)'));
    });

  proxy
    .command('clear')
    .description('Remove proxy settings (falls back to environment proxy variables)')
    .action(async () => {
      const config = await loadConfig({ checkSecrets: false });
      delete config.proxy;
      await saveConfig(config);
      console.log(chalk.green('✓ Proxy cleared (environment proxy will be used if set)'));
    });

  return cmd;
}
