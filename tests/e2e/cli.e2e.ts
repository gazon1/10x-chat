import { describe, expect, it } from 'vitest';
import { runCli, withTempHome } from './helpers.ts';

/**
 * End-to-end scenarios of the CLI flows that need neither a browser nor a
 * login. They are stable enough for CI and cover the argument surface of the
 * CLI (every command, the config round-trip and the error paths).
 */
describe('cli flows', () => {
  it('lists every command', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    for (const command of [
      'login',
      'chat',
      'delegate',
      'history',
      'image',
      'research',
      'status',
      'session',
      'config',
      'skill',
      'migrate',
    ]) {
      expect(result.output).toContain(command);
    }
  });

  it('bundles prompt and files with --dry-run', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(
        ['chat', '--dry-run', '-p', 'Explain this error', '--file', 'package.json'],
        { TEN_X_CHAT_HOME: home },
      );
      expect(result.code).toBe(0);
      expect(result.output).toContain('Explain this error');
      expect(result.output).toContain('10x-chat');
    });
  });

  it('rejects an unknown provider', async () => {
    const result = await runCli(['chat', '--dry-run', '-p', 'hi', '--provider', 'notebooklm']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Unknown provider');
  });

  it('writes and reads the configuration', async () => {
    await withTempHome(async (home) => {
      const set = await runCli(['config', 'set', 'provider', 'gemini'], { TEN_X_CHAT_HOME: home });
      expect(set.code).toBe(0);

      const show = await runCli(['config', 'show'], { TEN_X_CHAT_HOME: home });
      expect(show.code).toBe(0);
      expect(show.output).toContain('"defaultProvider": "gemini"');
    });
  });

  it('rejects a broken configuration instead of falling back', async () => {
    await withTempHome(async (home) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, 'config.json'), '{ "defaultProvider": "nope" }');

      const show = await runCli(['config', 'show'], { TEN_X_CHAT_HOME: home });
      expect(show.code).toBe(1);
      expect(show.output).toContain('Invalid config file');
    });
  });

  it('lists sessions and reports an unknown session id', async () => {
    await withTempHome(async (home) => {
      const status = await runCli(['status'], { TEN_X_CHAT_HOME: home });
      expect(status.code).toBe(0);

      const session = await runCli(['session', 'does-not-exist'], { TEN_X_CHAT_HOME: home });
      expect(session.code).toBe(1);
      expect(session.output.toLowerCase()).toContain('not found');
    });
  });

  it('previews the profile migration without touching anything', async () => {
    await withTempHome(async (home) => {
      const result = await runCli(['migrate', '--dry-run'], { TEN_X_CHAT_HOME: home });
      expect(result.code).toBe(0);
    });
  });
});
