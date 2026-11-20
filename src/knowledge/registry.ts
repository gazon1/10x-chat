import type { KnowledgeProvider } from './contract.js';
import { createNotebookLmProvider } from './notebooklm.js';

/** The knowledge providers of this process, by name. */
const providers = new Map<string, KnowledgeProvider>();

/**
 * Register a knowledge provider under its name.
 *
 * A provider with the same name replaces the old one — the last registration
 * wins, like in the provider registry.
 */
export function registerKnowledgeProvider(provider: KnowledgeProvider): KnowledgeProvider {
  providers.set(provider.name, provider);
  return provider;
}

/** Get a knowledge provider by name, throws if not found. */
export function getKnowledgeProvider(name: string): KnowledgeProvider {
  const provider = providers.get(name);
  if (!provider) {
    const available = [...providers.keys()].join(', ');
    throw new Error(`Unknown knowledge provider "${name}". Available: ${available}`);
  }
  return provider;
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
  registerKnowledgeProvider(createNotebookLmProvider());
}

registerKnowledgeProvider(createNotebookLmProvider());
