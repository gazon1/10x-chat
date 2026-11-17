import { loadConfig } from '../config.js';
import { getSecretStore, requireSecret } from '../secrets.js';
import type { ProviderName } from '../types.js';

/**
 * The credentials of this run.
 *
 * A credential is a secret of the store that the config file refers to by
 * name. The values never leave this module: the browser gets the proxy URL
 * without the credentials, and the daemon gets a hash of the proxy.
 */

/**
 * The API key of a provider.
 *
 * @returns the key, or `undefined` when the config file names no secret for
 *   the provider
 */
export async function getProviderApiKey(provider: ProviderName): Promise<string | undefined> {
  const config = await loadConfig();
  const name = config.providerKeys?.[provider];
  if (!name) return undefined;
  return requireSecret(getSecretStore(), name, `config key "providerKeys.${provider}"`);
}
