import type { ProviderName } from '../types.js';
import { createChatgptUseBackend } from './chatgpt-use.js';
import { createChromeUsePerplexityBackend } from './chrome-use-perplexity.js';
import type { AiBackend } from './contract.js';
import { createFakeBackend } from './fake.js';

/** The backends of this process, by name. */
const backends = new Map<string, AiBackend>();

/**
 * The provider a backend drives — the label of the sessions of its runs.
 *
 * The registry is the point of integration: a backend that answers for a
 * provider names it here, so the session of a run never claims another
 * provider and a new backend needs no change in the command.
 */
const providers = new Map<string, ProviderName>();

/**
 * Register a backend under its name.
 *
 * A backend with the same name replaces the old one — the last registration
 * wins, like in the provider registry. A backend that drives a provider
 * names it: the sessions of its runs are labeled with it.
 */
export function registerBackend(backend: AiBackend, provider?: ProviderName): AiBackend {
  backends.set(backend.name, backend);
  if (provider) {
    providers.set(backend.name, provider);
  } else {
    providers.delete(backend.name);
  }
  return backend;
}

/** The provider a backend drives — undefined when it names none. */
export function providerOfBackend(name: string): ProviderName | undefined {
  return providers.get(name);
}

/** Get a backend by name, throws if not found. */
export function getBackend(name: string): AiBackend {
  const backend = backends.get(name);
  if (!backend) {
    const available = [...backends.keys()].join(', ');
    throw new Error(`Unknown backend "${name}". Available: ${available}`);
  }
  return backend;
}

/** List all registered backend names. */
export function listBackends(): string[] {
  return [...backends.keys()];
}

/**
 * Forget every registered backend.
 *
 * The tests use it to start from a clean registry; the fake backend is
 * registered again, so it is always there.
 */
export function resetBackends(): void {
  backends.clear();
  providers.clear();
  registerBackend(createFakeBackend());
  registerBackend(createChatgptUseBackend(), 'chatgpt');
  registerBackend(createChromeUsePerplexityBackend(), 'perplexity');
}

/**
 * The backends of a run: the ones that answer for real.
 *
 * The fake backend is a test double: it stays registered (the tests and the
 * proof that the contract works without a browser need it), but a run of the
 * CLI must not offer it to a user — an answer that is canned must never look
 * like the answer of a provider.
 */
registerBackend(createFakeBackend());
registerBackend(createChatgptUseBackend(), 'chatgpt');
registerBackend(createChromeUsePerplexityBackend(), 'perplexity');
