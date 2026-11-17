import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatTimeoutMs,
  commandTimeoutMs,
  IMAGE_TIMEOUT_MS,
  RESEARCH_TIMEOUT_MS,
} from '../src/core/timeout.js';

describe('timeout of a chat', () => {
  it('prefers the flag over the config file', () => {
    expect(chatTimeoutMs(1000, 2000, 3000)).toBe(1000);
  });

  it('prefers the config file over the default of the provider', () => {
    expect(chatTimeoutMs(undefined, 2000, 3000)).toBe(2000);
  });

  it('falls back to the default of the provider', () => {
    expect(chatTimeoutMs(undefined, undefined, 3000)).toBe(3000);
  });
});

describe('timeout of the commands with their own default', () => {
  it('prefers the flag over the default of the command', () => {
    expect(commandTimeoutMs(1000, IMAGE_TIMEOUT_MS)).toBe(1000);
  });

  it('falls back to the default of the command', () => {
    expect(commandTimeoutMs(undefined, IMAGE_TIMEOUT_MS)).toBe(IMAGE_TIMEOUT_MS);
    expect(commandTimeoutMs(undefined, RESEARCH_TIMEOUT_MS)).toBe(RESEARCH_TIMEOUT_MS);
  });
});

describe('the config file only sets the timeout of a chat', () => {
  const read = (file: string) =>
    readFile(path.join(import.meta.dirname, '..', 'src', 'core', file), 'utf8');

  it('is used by the chat', async () => {
    expect(await read('orchestrator.ts')).toContain('config.defaultTimeoutMs');
  });

  it('is not used by the image and the research', async () => {
    expect(await read('image-orchestrator.ts')).not.toContain('defaultTimeoutMs');
    expect(await read('research-orchestrator.ts')).not.toContain('defaultTimeoutMs');
  });
});
