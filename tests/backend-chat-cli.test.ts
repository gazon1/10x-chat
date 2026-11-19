import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './e2e/helpers.js';

/** A data directory of its own, so a test run never touches the real profile. */
async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), '10x-chat-backend-cli-'));
}

/**
 * A directory with a `chatgpt-use` that answers with an envelope.
 *
 * The CLI runs the real backend: the stub stands in for the CLI, so the test
 * covers the adapter — the arguments, the envelope and the answer — without a
 * browser and without ChatGPT.
 */
async function stubCli(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-stub-cli-'));
  const stub = path.join(dir, 'chatgpt-use');
  await writeFile(
    stub,
    [
      '#!/bin/sh',
      'id=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--request-id" ]; then id="$2"; fi',
      '  shift',
      'done',
      'printf \'{"status":"completed","request_id":"%s","conversation_id":"conv-stub","result":{"text":"the answer of the stub"}}\' "$id"',
      '',
    ].join('\n'),
  );
  await chmod(stub, 0o755);
  return dir;
}

/** The environment of a run that finds the stub of the CLI first. */
async function stubEnv(): Promise<Record<string, string>> {
  const dir = await stubCli();
  return {
    TEN_X_CHAT_HOME: await tempHome(),
    PATH: `${dir}:${process.env.PATH ?? ''}`,
  };
}

/**
 * A `chatgpt-use` that answers with something that is not an envelope.
 *
 * The request may have reached ChatGPT: the hint of the failure must not
 * tell the user to send it again.
 */
async function garbageEnv(): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-garbage-cli-'));
  const stub = path.join(dir, 'chatgpt-use');
  await writeFile(stub, ['#!/bin/sh', 'printf "not an envelope"', ''].join('\n'));
  await chmod(stub, 0o755);
  return {
    TEN_X_CHAT_HOME: await tempHome(),
    PATH: `${dir}:${process.env.PATH ?? ''}`,
  };
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

  it('does not offer the test double to a user', async () => {
    const res = await runCli(['chat', '-p', 'hi', '--backend', 'fake'], {
      TEN_X_CHAT_HOME: await tempHome(),
    });
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/Unknown backend: fake/);
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

  it('runs a chat through the backend without a browser', async () => {
    const res = await runCli(
      ['chat', '-p', 'hi there', '--backend', 'chatgpt-use'],
      await stubEnv(),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Backend: chatgpt-use');
    expect(res.stdout).toContain('the answer of the stub');
  });

  it('refuses to save the images a backend does not produce', async () => {
    const res = await runCli(
      ['chat', '-p', 'hi', '--backend', 'chatgpt-use', '--save-images', '/tmp/images'],
      await stubEnv(),
    );
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/does not support image output/);
  });

  it('does not tell the user to send a request that may have reached ChatGPT again', async () => {
    const res = await runCli(['chat', '-p', 'hi', '--backend', 'chatgpt-use'], await garbageEnv());
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/Do not send it again/);
    expect(res.output).not.toMatch(/Run it again/);
  });
});
