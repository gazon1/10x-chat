import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Session store', () => {
  const originalEnv = process.env;
  let tempHome = '';
  let store: typeof import('../src/session/store.js');

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-sessions-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    store = await import('../src/session/store.js');
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('creates a session and reads it back', async () => {
    const meta = await store.createSession('chatgpt', 'hello world');
    expect(meta.status).toBe('pending');

    const result = await store.getSession(meta.id);
    expect(result.meta.id).toBe(meta.id);
    expect(result.meta.promptPreview).toBe('hello world');
    expect(result.responsePath).toBeUndefined();
  });

  it('updates a session', async () => {
    const meta = await store.createSession('gemini', 'hi');
    const updated = await store.updateSession(meta.id, { status: 'completed', durationMs: 1234 });

    expect(updated.status).toBe('completed');
    expect(updated.durationMs).toBe(1234);
    expect((await store.getSession(meta.id)).meta.status).toBe('completed');
  });

  it('finds a session by a unique prefix', async () => {
    const meta = await store.createSession('claude', 'hi');
    const result = await store.getSession(meta.id.slice(0, 8));
    expect(result.meta.id).toBe(meta.id);
  });

  it('reports an ambiguous prefix', async () => {
    // Two sessions with a common prefix (the random ids of createSession
    // would never share one).
    for (const id of ['aaa111', 'aaa222']) {
      const dir = path.join(tempHome, 'sessions', id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          id,
          provider: 'claude',
          promptPreview: 'hi',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'pending',
        }),
        'utf8',
      );
    }

    await expect(store.getSession('aaa')).rejects.toThrow(/ambiguous/);
  });

  it('reports a missing session', async () => {
    await expect(store.getSession('does-not-exist')).rejects.toThrow(/Session not found/);
  });

  it('reports a corrupted session instead of swallowing it', async () => {
    const meta = await store.createSession('grok', 'hi');
    await writeFile(path.join(tempHome, 'sessions', meta.id, 'meta.json'), '{ broken', 'utf8');

    await expect(store.getSession(meta.id)).rejects.toThrow(/Corrupted session/);
  });

  it('reports a session whose metadata has no fields', async () => {
    const meta = await store.createSession('grok', 'hi');
    await writeFile(
      path.join(tempHome, 'sessions', meta.id, 'meta.json'),
      JSON.stringify({ foo: 'bar' }),
      'utf8',
    );

    await expect(store.getSession(meta.id)).rejects.toThrow(/no valid session metadata/);
  });

  it('reports a session whose metadata is only partly filled', async () => {
    const meta = await store.createSession('grok', 'hi');
    // Valid JSON, but the fields that the CLI reads are missing.
    await writeFile(
      path.join(tempHome, 'sessions', meta.id, 'meta.json'),
      JSON.stringify({ id: meta.id, createdAt: new Date().toISOString() }),
      'utf8',
    );

    await expect(store.getSession(meta.id)).rejects.toThrow(/no valid session metadata/);
  });

  it('reports a session whose metadata has an unknown provider or status', async () => {
    const meta = await store.createSession('grok', 'hi');
    const complete = {
      id: meta.id,
      provider: 'grok',
      promptPreview: 'hi',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
    };

    await writeFile(
      path.join(tempHome, 'sessions', meta.id, 'meta.json'),
      JSON.stringify({ ...complete, provider: 'not-a-provider' }),
      'utf8',
    );
    await expect(store.getSession(meta.id)).rejects.toThrow(/no valid session metadata/);

    await writeFile(
      path.join(tempHome, 'sessions', meta.id, 'meta.json'),
      JSON.stringify({ ...complete, status: 'almost-done' }),
      'utf8',
    );
    await expect(store.getSession(meta.id)).rejects.toThrow(/no valid session metadata/);
  });

  it('skips a session with incomplete metadata when listing the sessions', async () => {
    await store.createSession('grok', 'hi');
    const partial = await store.createSession('grok', 'hi');
    await writeFile(
      path.join(tempHome, 'sessions', partial.id, 'meta.json'),
      JSON.stringify({ id: partial.id, createdAt: new Date().toISOString() }),
      'utf8',
    );

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(partial.id);
  });

  it('skips a corrupted session when listing the sessions', async () => {
    await store.createSession('grok', 'hi');
    const broken = await store.createSession('grok', 'hi');
    await writeFile(path.join(tempHome, 'sessions', broken.id, 'meta.json'), '{ broken', 'utf8');

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(broken.id);
  });

  it('rejects a session id that would escape the sessions directory', async () => {
    await expect(store.getSession('../../etc')).rejects.toThrow(/Invalid session id/);
  });

  it('lists the sessions newest first', async () => {
    const first = await store.createSession('grok', 'first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.createSession('grok', 'second');

    const sessions = await store.listSessions();
    expect(sessions[0].id).toBe(second.id);
    expect(sessions[1].id).toBe(first.id);
  });

  it('leaves no temporary file behind when the metadata is written', async () => {
    const meta = await store.createSession('grok', 'hi');
    const dir = path.join(tempHome, 'sessions', meta.id);
    await mkdir(dir, { recursive: true });

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files).toEqual(['meta.json']);
  });
});
