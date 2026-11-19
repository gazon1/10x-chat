import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './e2e/helpers.js';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-transport-cli-'));
  process.env.TEN_X_CHAT_CREDENTIAL_STORAGE = 'file';
  await mkdir(home, { recursive: true });
});

afterEach(() => {
  delete process.env.TEN_X_CHAT_CREDENTIAL_STORAGE;
});

describe('chat transport validation (CLI)', () => {
  it('explains supported provider/transport when a provider has no API transport', async () => {
    const res = await runCli(['chat', '-p', 'hi', '--provider', 'chatgpt', '--transport', 'api'], {
      TEN_X_CHAT_HOME: home,
    });
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/no API transport/i);
    expect(res.output).toMatch(/--transport browser/);
  });

  it('rejects browser-only flags for the api transport', async () => {
    // needs a configured key so it reaches the transport capability check
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ providerKeys: { deepseek: 'deepseek-key' } }),
      'utf-8',
    );
    await runCli(['secrets', 'set', 'deepseek-key'], { TEN_X_CHAT_HOME: home }, 'sk-test');
    const res = await runCli(
      ['chat', '-p', 'hi', '--provider', 'deepseek', '--transport', 'api', '--headed'],
      { TEN_X_CHAT_HOME: home },
    );
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/does not use a browser/i);
  });
});
