import type { KnowledgeProvider, KnowledgeProviderOptions } from './contract.js';
import { createNotebookLmProvider, NOTEBOOKLM_PROVIDER_NAME } from './notebooklm.js';

/**
 * A factory of a knowledge provider.
 *
 * The registry holds factories, not instances: the options of the run (the
 * profile, the deadline) belong to the call, not to the registry.
 */
export type KnowledgeProviderFactory = (options: KnowledgeProviderOptions) => KnowledgeProvider;

/** The knowledge providers of this process, by name. */
const providers = new Map<string, KnowledgeProviderFactory>();

/**
 * Register a knowledge provider under its name.
 *
 * A provider with the same name replaces the old one — the last registration
 * wins, like in the provider registry.
 */
export function registerKnowledgeProvider(name: string, factory: KnowledgeProviderFactory): void {
  providers.set(name, factory);
}

/**
 * Get a knowledge provider by name, throws if not found.
 *
 * The options are the ones of the call: the profile of the session and the
 * deadline of the operations.
 */
export function getKnowledgeProvider(
  name: string,
  options: KnowledgeProviderOptions = {},
): KnowledgeProvider {
  const factory = providers.get(name);
  if (!factory) {
    const available = [...providers.keys()].join(', ');
    throw new Error(`Unknown knowledge provider "${name}". Available: ${available}`);
  }
  return factory(options);
}

/** List all registered knowledge provider names. */
export function listKnowledgeProviders(): string[] {
  return [...providers.keys()];
}

/**
 * Forget every registered knowledge provider.
 *
 * The tests use it to start from a clean registry.
 */
export function resetKnowledgeProviders(): void {
  providers.clear();
  registerKnowledgeProvider(NOTEBOOKLM_PROVIDER_NAME, (options) =>
    createNotebookLmProvider(options),
  );
}

resetKnowledgeProviders();
