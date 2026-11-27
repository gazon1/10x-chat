import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
        'workflows/idea-adoption.md',
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
        'workflows/idea-adoption.md',
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

it('refuses an issue without a pull request and an issue that is not a number', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    // The Issue is the requirements of a pull request: without one there is
    // nothing for it to govern.
    const alone = await runCli(['review', '--issue', '57'], env);
    expect(alone.code).toBe(1);
    expect(alone.output).toContain('--issue option is supported together with --pr');
    const garbage = await runCli(['review', '--pr', '42', '--issue', '57garbage'], env);
    expect(garbage.code).toBe(1);
    expect(garbage.output).toContain('Invalid --issue value');
  });
});

/**
 * A `chatgpt-use` that answers with the envelope of the CLI: one finding for
 * the reviewers, a verdict for every candidate of the verification.
 */
const FAKE_CHATGPT_USE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const idAt = args.indexOf('--request-id');
const requestId = idAt >= 0 ? args[idAt + 1] : '';
const sepAt = args.indexOf('--');
const prompt = sepAt >= 0 ? args.slice(sepAt + 1).join(' ') : '';
let text;
if (prompt.indexOf('# Follow-up improvements') >= 0) {
  // The advisory assessment is its own request with its own schema: an
  // answer of the reviewer shape would fail it, and a report that renders the
  // heading anyway would hide the failure.
  text = JSON.stringify({
    recommendations: [
      {
        title: 'Name the profile in the workflow record',
        rationale: 'An operator reads the record to know how a change was judged.',
        evidence: ['src/pipeline/review.ts'],
        benefit: 'The coverage of a review is visible where it is stored.',
        scope: 'One field of the workflow review record.',
        priority: 'RECOMMENDED',
        separateWork: true,
      },
    ],
  });
} else if (prompt.indexOf('# Verification') >= 0) {
  const ids = Array.from(new Set(prompt.match(/f-[0-9a-f]{8}/g) || []));
  text = JSON.stringify({
    verdicts: ids.map((id) => ({
      id: id,
      verdict: 'confirmed',
      evidence: 'the excerpt of the file shows the defect',
      note: 'confirmed by the test double',
    })),
  });
} else {
  const findings =
    process.env.FAKE_REVIEW_FINDINGS === 'none'
      ? []
      : [
          {
            title: 'The reviewer names a defect of the change',
            severity: 'MAJOR',
            category: 'correctness',
            file: 'src/app.ts',
            line: 1,
            problem: 'The function of the file is wrong.',
            impact: 'A caller gets a wrong result.',
            evidence: ['the first line of the file'],
            fix: 'Fix the function.',
          },
        ];
  text = JSON.stringify({ findings: findings, decisions: [] });
}
process.stdout.write(
  JSON.stringify({ status: 'completed', request_id: requestId, result: { text: text } }),
);
`;

/** Run a git command in a directory. */
async function gitIn(cwd: string, ...args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args],
      { cwd },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/** A repository with a commit on `main` and a change on `feature`. */
async function createReviewRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), '10x-chat-e2e-review-'));
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await writeFile(path.join(cwd, 'src', 'app.ts'), 'export const a = 1;\n', 'utf-8');
  await gitIn(cwd, 'init', '--initial-branch=main');
  await gitIn(cwd, 'add', '.');
  await gitIn(cwd, 'commit', '-m', 'first');
  await gitIn(cwd, 'checkout', '-b', 'feature');
  await writeFile(path.join(cwd, 'src', 'app.ts'), 'export const a = 2;\n', 'utf-8');
  await gitIn(cwd, 'add', '.');
  await gitIn(cwd, 'commit', '-m', 'second');
  return cwd;
}

/**
 * A `gh` that answers with the pull request and with the governing Issue.
 *
 * The commits of the pull request are the commits of the checkout: the script
 * asks git for them, so the review compares the branches of the repository.
 */
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
"pr view")
  printf '{"number":42,"url":"https://github.com/owner/name/pull/42","title":"Add the run function","baseRefName":"main","baseRefOid":"%s","headRefName":"feature","headRefOid":"%s"}' "$(git rev-parse main)" "$(git rev-parse feature)"
  ;;
"issue view")
  printf '{"number":7,"url":"https://github.com/owner/name/issues/7","title":"The requirements of the change","body":"The change must do what the issue says."}'
  ;;
esac
`;

it('reviews a pull request against the requirements of its issue', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    // The repository of the checkout: the Issue is read from it.
    await gitIn(repo, 'remote', 'add', 'origin', 'https://github.com/owner/name.git');
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      await writeFile(path.join(bin, 'gh'), FAKE_GH, 'utf-8');
      await chmod(path.join(bin, 'gh'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      const approve = await runCli(
        ['review', '--pr', '42', '--issue', '7'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );

      expect(approve.code).toBe(0);
      expect(approve.output).toContain('APPROVE');
      // The report names the Issue and the version of it that was judged.
      expect(approve.output).toContain('issue #7');
      expect(approve.output).toContain('The requirements of the change');
      // The baseline of the Issue is written by the completed review.
      const baseline = path.join(home, 'requirements', 'owner', 'name', '7.json');
      const stored = JSON.parse(await readFile(baseline, 'utf-8'));
      expect(stored.number).toBe(7);
      expect(stored.repository).toBe('owner/name');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

it('tells the caller of a review what the verdict is', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      // A confirmed MAJOR finding asks for changes: the exit code says so.
      const changes = await runCli(
        ['review', '--base', 'main', '--head', 'feature'],
        env,
        undefined,
        { cwd: repo },
      );
      expect(changes.code).toBe(1);
      expect(changes.output).toContain('REQUEST CHANGES');

      // A review without a finding approves: the exit code says that too.
      const approve = await runCli(
        ['review', '--base', 'main', '--head', 'feature'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(approve.code).toBe(0);
      expect(approve.output).toContain('APPROVE');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

it('refuses a review profile that is not one of the four', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    const result = await runCli(['review', '--pr', '42', '--profile', 'thorough'], env);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Invalid --profile value');
    expect(result.output).toContain('quick, standard, deep, critical');
  });
});

it('refuses a critical review that has no issue to judge the change against', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    const result = await runCli(['review', '--pr', '42', '--profile', 'critical'], env);
    expect(result.code).toBe(1);
    expect(result.output).toContain('needs --pr and --issue');
  });
});

it('runs a quick review as an explicitly incomplete review', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      // The only reviewer pass finds nothing, and the run still is not an
      // approval: the stages the profile omits are named, and the exit code
      // says the review is incomplete.
      const quick = await runCli(
        ['review', '--base', 'main', '--head', 'feature', '--profile', 'quick'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(quick.code).toBe(1);
      expect(quick.output).toContain('REQUEST CHANGES');
      expect(quick.output).toContain('Profile: quick');
      expect(quick.output).toContain('cannot approve a change');
      expect(quick.output).toContain('the review is incomplete');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

it('runs the full review through the CLI when no profile is named', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      // Omitting --profile is the common invocation: it has to reach the
      // pipeline as standard, with the advisory assessment intact. The
      // library-level test cannot catch a CLI default that drifts.
      const approve = await runCli(
        ['review', '--base', 'main', '--head', 'feature'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(approve.code).toBe(0);
      expect(approve.output).toContain('- Profile: standard');
      expect(approve.output).toContain('APPROVE');
      // The advisory assessment ran — a profile that omitted it says so.
      // The assessment ran and its recommendation is in the report — the
      // heading alone says nothing, because it renders for a failed
      // assessment too.
      expect(approve.output).toContain('## Follow-up improvements');
      expect(approve.output).toContain('Name the profile in the workflow record');
      expect(approve.output).not.toContain('The advisory assessment was unavailable');
      expect(approve.output).not.toContain('does not run the advisory assessment');
      expect(approve.output).not.toContain('SKIPPED');

      // The explicit name does the same thing.
      const named = await runCli(
        ['review', '--base', 'main', '--head', 'feature', '--profile', 'standard'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(named.code).toBe(0);
      expect(named.output).toContain('- Profile: standard');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

it('explains the cost and coverage of every profile in the help', async () => {
  await withTempHome(async (home) => {
    const env = { TEN_X_CHAT_HOME: home, TEN_X_CHAT_CREDENTIAL_STORAGE: 'file' };
    const help = await runCli(['review', '--help'], env);

    expect(help.code).toBe(0);
    // The acceptance criterion is the help itself: an operator chooses a
    // profile from here, and it has to say what each one costs and omits.
    expect(help.output).toContain('--profile');
    for (const profile of ['quick', 'standard', 'deep', 'critical']) {
      expect(help.output).toContain(profile);
    }
    // The help wraps to the width of the terminal, so the phrases are checked
    // in the words that survive a line break rather than as whole sentences.
    expect(help.output).toContain('cost/coverage profile');
    expect(help.output).toContain('verification, no advisory assessment');
    expect(help.output).toContain('never');
    expect(help.output).toContain('every unverified finding asks for changes');
    expect(help.output).toContain('--issue is required');
    expect(help.output).toContain('default: standard');
  });
});

it('runs a deep review through the CLI and applies its stricter gate', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      // deep is standard plus the gate: the stages are the same, so a run
      // with nothing to verify still approves — and the profile really
      // reached the pipeline rather than falling back to standard.
      const deep = await runCli(
        ['review', '--base', 'main', '--head', 'feature', '--profile', 'deep'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(deep.code).toBe(0);
      expect(deep.output).toContain('- Profile: deep');
      expect(deep.output).toContain('APPROVE');
      // Every stage ran: deep omits nothing, unlike quick.
      expect(deep.output).not.toContain('SKIPPED');
      expect(deep.output).toContain('## Follow-up improvements');
      expect(deep.output).toContain('Name the profile in the workflow record');
      expect(deep.output).not.toContain('does not run the advisory assessment');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

it('runs a critical review through the CLI with its Issue', async () => {
  await withTempHome(async (home) => {
    const repo = await createReviewRepo();
    // The repository of the checkout: the Issue is read from it.
    await gitIn(repo, 'remote', 'add', 'origin', 'https://github.com/owner/name.git');
    const bin = path.join(home, 'bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'chatgpt-use'), FAKE_CHATGPT_USE, 'utf-8');
      await chmod(path.join(bin, 'chatgpt-use'), 0o755);
      await writeFile(path.join(bin, 'gh'), FAKE_GH, 'utf-8');
      await chmod(path.join(bin, 'gh'), 0o755);
      const env = {
        TEN_X_CHAT_HOME: home,
        TEN_X_CHAT_CREDENTIAL_STORAGE: 'file',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };

      // The refusal of `critical` without an Issue is tested next door. What
      // this pins is the other half of the path: --pr, --issue and --profile
      // all reach the pipeline together, and the run approves.
      const critical = await runCli(
        ['review', '--pr', '42', '--issue', '7', '--profile', 'critical'],
        { ...env, FAKE_REVIEW_FINDINGS: 'none' },
        undefined,
        { cwd: repo },
      );
      expect(critical.code).toBe(0);
      expect(critical.output).toContain('- Profile: critical');
      expect(critical.output).toContain('APPROVE');
      // The Issue really reached the pipeline — not only the option parser.
      expect(critical.output).toContain('issue #7');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
