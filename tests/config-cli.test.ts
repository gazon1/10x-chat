import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigCommand } from '../src/cli/config.js';
import { getSecretStore } from '../src/secrets.js';

let home = '';

async function run(args: string[]): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    await createConfigCommand().parseAsync(args, { from: 'user' });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return logs.join('\n');
}

async function readConfig(): Promise<any> {
  return JSON.parse(await readFile(path.join(home, 'config.json'), 'utf-8'));
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-config-cli-'));
  process.env.TEN_X_CHAT_HOME = home;
  process.env.TEN_X_CHAT_CREDENTIAL_STORAGE = 'file';
  await mkdir(home, { recursive: true });
});

afterEach(() => {
  delete process.env.TEN_X_CHAT_HOME;
  delete process.env.TEN_X_CHAT_CREDENTIAL_STORAGE;
});

describe('config proxy commands', () => {
  it('sets, disables and clears the proxy', async () => {
    await run(['proxy', 'set', 'http://proxy.example:3128', '--bypass', 'localhost,127.0.0.1']);
    let cfg = await readConfig();
    expect(cfg.proxy).toEqual({
      enabled: true,
      server: 'http://proxy.example:3128',
      bypass: ['localhost', '127.0.0.1'],
    });

    await run(['proxy', 'disable']);
    cfg = await readConfig();
    expect(cfg.proxy).toEqual({
      enabled: false,
      server: 'http://proxy.example:3128',
      bypass: ['localhost', '127.0.0.1'],
    });

    await run(['proxy', 'clear']);
    cfg = await readConfig();
    expect(cfg.proxy).toBeUndefined();
  });

  it('disables the proxy even without an existing section (suppresses env fallback)', async () => {
    await run(['proxy', 'disable']);
    const cfg = await readConfig();
    expect(cfg.proxy).toEqual({ enabled: false });
  });

  it('rejects credentials in the proxy URL', async () => {
    const exit = process.exit;
    let code: number | undefined;
    (process.exit as any) = (c: number) => {
      code = c;
      throw new Error('exit');
    };
    try {
      await expect(run(['proxy', 'set', 'http://user:pass@proxy.example:3128'])).rejects.toThrow();
      expect(code).toBe(1);
      const cfg = await readConfig().catch(() => ({}));
      expect(cfg.proxy).toBeUndefined();
    } finally {
      process.exit = exit;
    }
  });

  it('removes proxy via config unset proxy', async () => {
    await run(['proxy', 'set', 'http://proxy.example:3128']);
    await run(['unset', 'proxy']);
    const cfg = await readConfig();
    expect(cfg.proxy).toBeUndefined();
  });
});

describe('config chatgpt-project', () => {
  it('sets, shows and unsets chatgpt-project', async () => {
    await run(['set', 'chatgpt-project', 'chatgpt-use']);
    let cfg = await readConfig();
    expect(cfg.chatgptProject).toBe('chatgpt-use');

    const shown = await run(['show']);
    expect(shown).toContain('chatgptProject');
    expect(shown).toContain('chatgpt-use');

    await run(['unset', 'chatgpt-project']);
    cfg = await readConfig();
    expect(cfg.chatgptProject).toBeUndefined();
  });

  it('rejects an empty chatgpt-project', async () => {
    const exit = process.exit;
    let code: number | undefined;
    (process.exit as any) = (c: number) => {
      code = c;
      throw new Error('exit');
    };
    try {
      await expect(run(['set', 'chatgpt-project', '   '])).rejects.toThrow();
      expect(code).toBe(1);
      const cfg = await readConfig().catch(() => ({}));
      expect(cfg.chatgptProject).toBeUndefined();
    } finally {
      process.exit = exit;
    }
  });
});

describe('config show effective state', () => {
  it('reports provider secret configured/missing and proxy without printing secret values', async () => {
    const secretValue = 'sk-do-not-print-me';
    await getSecretStore().set('deepseek-key', secretValue);
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({
        providerKeys: { deepseek: 'deepseek-key', chatgpt: 'missing-key' },
        proxy: { enabled: true, server: 'http://proxy.example:3128' },
      }),
      'utf-8',
    );
    await getSecretStore().set('proxy.username', 'proxy-user-secret');
    await getSecretStore().set('proxy.password', 'proxy-pass-secret');

    const out = await run(['show']);
    expect(out).toContain('deepseek');
    expect(out).toContain('configured');
    expect(out).toContain('chatgpt');
    expect(out).toContain('missing secret');
    expect(out).toContain('proxy');
    expect(out).toContain('config (enabled)');
    expect(out).toContain('http://proxy.example:3128');
    expect(out).toContain('username=configured');
    expect(out).toContain('password=configured');
    expect(out).toContain('browser, api');
    expect(out).not.toContain(secretValue);
    expect(out).not.toContain('proxy-user-secret');
    expect(out).not.toContain('proxy-pass-secret');
  });
});
