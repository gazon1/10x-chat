import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './e2e/helpers.js';

/** A data directory of its own, so a test run never touches the real profile. */
async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), '10x-chat-backend-cli-'));
}

describe('the --backend option of chat (CLI)', () => {
  it('rejects an unknown backend and names the ones that exist', async () => {
    const res = await runCli(['chat', '-p', 'hi', '--backend', 'nope'], {
      TEN_X_CHAT_HOME: await tempHome(),
    });
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/Unknown backend: nope/);
    expect(res.output).toMatch(/chatgpt-use/);
  });

  it('refuses the options that a backend cannot honour', async () => {
    const home = await tempHome();
    const cases: [string[], RegExp][] = [
      [['--transport', 'api'], /backend and --transport/i],
      [['--headed'], /browser flags/i],
      [['--new-chat'], /--backend and --new-chat/i],
      [['--all'], /--all and --backend/i],
      [['--provider', 'gemini'], /drives chatgpt/i],
    ];
    for (const [args, pattern] of cases) {
      const res = await runCli(['chat', '-p', 'hi', '--backend', 'chatgpt-use', ...args], {
        TEN_X_CHAT_HOME: home,
      });
      expect(res.code).toBe(1);
      expect(res.output).toMatch(pattern);
    }
  });

  it('runs a chat through a backend without a browser', async () => {
    const res = await runCli(['chat', '-p', 'hi there', '--backend', 'fake'], {
      TEN_X_CHAT_HOME: await tempHome(),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Backend: fake');
    expect(res.stdout).toContain('Fake answer for: hi there');
  });
});
