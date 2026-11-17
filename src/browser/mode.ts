import type { ProviderConfig } from '../types.js';

/**
 * Resolve whether a provider should run headless for this invocation.
 *
 * Explicit --headed/--headless wins. Otherwise the provider decides: a
 * provider that only works in a visible browser (`requiresHeaded`) runs
 * headed, every other provider follows the config file.
 */
export function resolveHeadlessMode(
  provider: Pick<ProviderConfig, 'requiresHeaded'>,
  configHeadless: boolean,
  headedOverride = false,
  headlessOverride = false,
): boolean {
  if (headedOverride) return false;
  if (headlessOverride) return true;
  if (provider.requiresHeaded) return false;
  return configHeadless;
}
