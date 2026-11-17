import type { ApiTransport, ProviderName } from '../../types.js';
import { deepseekApiTransport } from './deepseek.js';

/**
 * The API transports of the providers.
 *
 * A provider without an entry here has no API transport: `--transport api`
 * fails for it instead of silently falling back to the browser.
 */
const API_TRANSPORTS: Partial<Record<ProviderName, ApiTransport>> = {
  deepseek: deepseekApiTransport,
};

/** The API transport of a provider, or undefined when it has none. */
export function getApiTransport(name: ProviderName): ApiTransport | undefined {
  return API_TRANSPORTS[name];
}

/** The providers that have an API transport. */
export function listApiProviders(): ProviderName[] {
  return Object.keys(API_TRANSPORTS) as ProviderName[];
}
