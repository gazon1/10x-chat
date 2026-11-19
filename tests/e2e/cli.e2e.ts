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
      'secrets',
      'skill',
      'migrate',
      'daemon',
    ]) {
      expect(result.output).toContain(command);
    }
  });

  it('reports the state of the browser daemon', async () => {
    await withTempHome(async (home) => {
      const status = await runCli(['daemon', 'status'], { TEN_X_CHAT_HOME: home });
      expect(status.code).toBe(0);
      expect(status.output).toContain('not running');

      const stop = await runCli(['daemon', 'stop'], { TEN_X_CHAT_HOME: home });
      expect(stop.code).toBe(0);
      expect(stop.output).toContain('not running');
    });
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

  it('stores a secret, lists its name and removes it again', async () => {
    await withTempHome(async (home) => {
      const value = 'sk-do-not-print-me';
      const env = { TEN_X_CHAT_HOME: home };

      const set = await runCli(['secrets', 'set', 'openai-key'], env, value);
      expect(set.code).toBe(0);
      expect(set.output).not.toContain(value);

      const list = await runCli(['secrets', 'list'], env);
      expect(list.code).toBe(0);
      expect(list.output).toContain('openai-key');
      expect(list.output).not.toContain(value);

      // The secret is still there in the next invocation.
      const show = await runCli(['config', 'show'], env);
      expect(show.code).toBe(0);
      expect(show.output).not.toContain(value);

      const remove = await runCli(['secrets', 'remove', 'openai-key'], env);
      expect(remove.code).toBe(0);

      const empty = await runCli(['secrets', 'list'], env);
      expect(empty.output).not.toContain('openai-key');
    });
  });

  it('refuses to store a secret when the config file is broken', async () => {
    await withTempHome(async (home) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      await mkdir(home, { recursive: true });
      await writeFile(path.join(home, 'config.json'), '{ not json');

      // The command must not fall back to the plaintext file behind the back
      // of the user — the config file chooses where the secrets live. The
      // environment must not decide it either.
      const result = await runCli(
        ['secrets', 'set', 'openai-key'],
        { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: undefined },
        'value',
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain('Invalid config file');

      const { access } = await import('node:fs/promises');
      await expect(access(path.join(home, 'secrets.json'))).rejects.toThrow();
    });
  });

  it('refuses a config file that refers to a secret that does not exist', async () => {
    await withTempHome(async (home) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, 'config.json'),
        JSON.stringify({ providerKeys: { chatgpt: 'openai-key' } }),
      );

      const result = await runCli(['config', 'show'], { TEN_X_CHAT_HOME: home });
      expect(result.code).toBe(0);

      const history = await runCli(['history'], { TEN_X_CHAT_HOME: home });
      expect(history.code).toBe(1);
      expect(history.output).toContain('No secret named "openai-key"');
    });
  });

  it('installs the skill with its playbooks and working links', async () => {
    await withTempHome(async (home) => {
      const { existsSync } = await import('node:fs');
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');

      const result = await runCli(['skill', 'install'], { HOME: home });
      expect(result.code).toBe(0);

      const skillDir = path.join(home, '.codex', 'skills', '10x-chat');
      for (const file of [
        'SKILL.md',
        'workflows/pr-review.md',
        'workflows/helix-development.md',
        'workflows/report-format.md',
      ]) {
        expect(existsSync(path.join(skillDir, file))).toBe(true);
      }

      // Every relative link of the installed skill must resolve in the
      // installed copy — the paths differ from the repository checkout. The
      // workflows link to each other, so every file is checked.
      for (const file of [
        'SKILL.md',
        'workflows/pr-review.md',
        'workflows/helix-development.md',
        'workflows/report-format.md',
      ]) {
        const filePath = path.join(skillDir, file);
        const content = await readFile(filePath, 'utf-8');
        const links = [...content.matchAll(/\]\(([^)]+)\)/g)]
          .map((m) => m[1])
          .filter((link) => !/^[a-z]+:\/\//i.test(link));
        for (const link of links) {
          expect(existsSync(path.resolve(path.dirname(filePath), link))).toBe(true);
        }
      }

      // The links of the skill must exist, too — the check above only fails
      // when a link is broken, not when the skill has none.
      const skill = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
      const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
      expect(links.length).toBeGreaterThan(0);
    });
  });

  it('installs the review playbook with two complete reviewer commands', async () => {
    await withTempHome(async (home) => {
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');

      const result = await runCli(['skill', 'install'], { HOME: home });
      expect(result.code).toBe(0);

      const playbook = await readFile(
        path.join(home, '.codex', 'skills', '10x-chat', 'workflows', 'pr-review.md'),
        'utf-8',
      );

      const count = (needle: string): number => playbook.split(needle).length - 1;

      // A placeholder that points at the other role is not a command: copied
      // literally it sends a reviewer into the chat without the pull request.
      expect(playbook).not.toMatch(/same repository coordinates|same block as Role A/i);
      expect(count('10x-chat chat --provider')).toBe(2);

      // Both roles get the coordinates and the finding schema of their own.
      for (const command of playbook.split('10x-chat chat --provider').slice(1)) {
        expect(command).toMatch(/Repository:\s+https:\/\/github\.com\/<owner>\/<name>/);
        expect(command).toMatch(/Pull request: #<n> — https:\/\/github\.com\/<owner>/);
        expect(command).toMatch(/Base:\s+<base-sha>/);
        expect(command).toMatch(/Head:\s+<head-sha>/);
        expect(command).toMatch(/Changed files:/);
        expect(command).toMatch(/SEVERITY: BLOCKING \| MAJOR \| MINOR \| INFO/);
        expect(command).toMatch(/LOCATION:/);
        expect(command).toMatch(/PROBLEM:/);
        expect(command).toMatch(/IMPACT:/);
        expect(command).toMatch(/EVIDENCE:/);
        expect(command).toMatch(/FIX:/);
      }
    });
  });
});

it('rejects --all with the api transport', async () => {
  await withTempHome(async (home) => {
    const result = await runCli(['chat', '-p', 'hi', '--all', '--transport', 'api'], {
      TEN_X_CHAT_HOME: home,
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(
      /--all.*--transport api|transport api.*--all|browser transport only/i,
    );
  });
});

it('configures proxy and provider key via CLI and shows effective state', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };

    let res = await runCli(
      ['config', 'proxy', 'set', 'http://proxy.example:3128', '--bypass', 'localhost'],
      env,
    );
    expect(res.code).toBe(0);
    res = await runCli(['config', 'proxy', 'disable'], env);
    expect(res.code).toBe(0);
    res = await runCli(['config', 'proxy', 'clear'], env);
    expect(res.code).toBe(0);

    const secretValue = 'sk-e2e-do-not-print';
    res = await runCli(['secrets', 'set', 'deepseek-key'], env, secretValue);
    expect(res.code).toBe(0);
    res = await runCli(['config', 'set', 'provider-key', 'deepseek', 'deepseek-key'], env);
    expect(res.code).toBe(0);

    const show = await runCli(['config', 'show'], env);
    expect(show.code).toBe(0);
    expect(show.output).toContain('deepseek-key');
    expect(show.output).toContain('configured');
    expect(show.output).toContain('browser, api');
    expect(show.output).not.toContain(secretValue);
  });
});

it('rejects proxy URL with embedded credentials via CLI', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    const res = await runCli(
      ['config', 'proxy', 'set', 'http://user:pass@proxy.example:3128'],
      env,
    );
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/must not contain credentials|credentials/i);
    expect(res.output).not.toContain('user:pass');
  });
});

it('rejects --transport api without --provider even when defaultProvider is configured for api', async () => {
  await withTempHome(async (home) => {
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ defaultProvider: 'deepseek', providerKeys: { deepseek: 'deepseek-key' } }),
    );
    const set = await runCli(['secrets', 'set', 'deepseek-key'], env, 'sk-test-key');
    expect(set.code).toBe(0);

    const result = await runCli(['chat', '-p', 'hi', '--transport', 'api'], env);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/requires --provider/i);
    expect(result.output).not.toContain('sk-test-key');
  });
});

it('refuses a pull request number that is not a number', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    // `42garbage` is not the pull request 42 — a mistake must not review
    // another pull request than the one that was named.
    const result = await runCli(['review', '--pr', '42garbage'], env);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Invalid --pr value');
  });
});

it('refuses a timeout that is not a number', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    const result = await runCli(['review', '--timeout', '100ms'], env);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Invalid --timeout value');
  });
});
