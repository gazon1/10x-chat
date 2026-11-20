import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './e2e/helpers.js';

/**
 * A `notebooklm` that answers with an envelope.
 *
 * The CLI runs the real provider: the stub stands in for the CLI of
 * `notebooklm-py`, so the test covers the envelope of the command without
 * NotebookLM and without an account.
 */
async function stubEnv(stdout: string, exitCode = 0): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-notebooklm-stub-'));
  const stub = path.join(dir, 'notebooklm');
  await writeFile(
    stub,
    ['#!/bin/sh', `printf '%s' '${stdout}'`, `exit ${exitCode}`, ''].join('\n'),
  );
  await chmod(stub, 0o755);
  const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-knowledge-home-'));
  return { TEN_X_CHAT_HOME: home, PATH: `${dir}:${process.env.PATH ?? ''}` };
}

describe('the knowledge command (CLI)', () => {
  it('prints the versioned envelope of the operation', async () => {
    const res = await runCli(
      ['knowledge', 'notebooks', 'list', '--json'],
      await stubEnv('{"notebooks":[{"id":"nb1","title":"Research"}],"count":1}'),
    );

    expect(res.code).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.schema).toBe('10x-chat/knowledge/v1');
    expect(envelope.provider).toBe('notebooklm');
    expect(envelope.operation).toBe('notebooks.list');
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual([{ id: 'nb1', title: 'Research' }]);
  });

  it('keeps the stdout machine-readable when the provider fails', async () => {
    const res = await runCli(
      ['knowledge', 'notebooks', 'list', '--json'],
      await stubEnv('{"error":true,"code":"AUTH_ERROR","message":"Authentication error."}', 1),
    );

    expect(res.code).toBe(1);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe('unauthorized');
    expect(envelope.error.code).toBe('AUTH_ERROR');
  });

  it('prints the answer of a question', async () => {
    const res = await runCli(
      ['knowledge', 'ask', '--notebook', 'nb1', '--question', 'what is it?', '--json'],
      await stubEnv('{"answer":"It is research."}'),
    );

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).data.answer).toBe('It is research.');
  });

  it('says that the provider is not there when it is not installed', async () => {
    // A PATH with the node of the test and nothing else: the CLI of the
    // provider is not on it.
    const dir = await mkdtemp(path.join(os.tmpdir(), '10x-chat-empty-path-'));
    await symlink(process.execPath, path.join(dir, 'node'));
    const home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-knowledge-home-'));
    const res = await runCli(['knowledge', 'status', '--json'], {
      TEN_X_CHAT_HOME: home,
      PATH: dir,
    });

    expect(res.code).toBe(1);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe('unavailable');
  });
});
