import type { AiBackend } from './contract.js';
import { createFakeBackend } from './fake.js';

/** The backends of this process, by name. */
const backends = new Map<string, AiBackend>();

/**
 * Register a backend under its name.
 *
 * A backend with the same name replaces the old one — the last registration
 * wins, like in the provider registry.
 */
export function registerBackend(backend: AiBackend): AiBackend {
  backends.set(backend.name, backend);
  return backend;
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
  registerBackend(createFakeBackend());
}

/**
 * The fake backend is registered from the start: it is the backend of the
 * tests and the proof that the contract works without a browser.
 */
registerBackend(createFakeBackend());
