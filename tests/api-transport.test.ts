import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTransport, runApiChat } from '../src/core/api-orchestrator.js';
import { failureKind } from '../src/core/failures.js';
import { runChat } from '../src/core/orchestrator.js';
import { deepseekApiTransport } from '../src/providers/api/deepseek.js';
import { getSecretStore } from '../src/secrets.js';
import { getSession, listSessions } from '../src/session/index.js';
import type {
  ApiHttpClient,
  ApiHttpResponse,
  ApiRequest,
  ApiTransport,
  CapturedResponse,
} from '../src/types.js';

const KEY = 'sk-test-key-do-not-print';

let home = '';

/** A transport that answers without a network and without a browser. */
function fakeTransport(answer: Partial<CapturedResponse> = {}): ApiTransport & {
  calls: ApiRequest[];
} {
  const calls: ApiRequest[] = [];
  return {
    calls,
    capabilities: { attachments: false, streaming: false, cancellation: false },
    async send(req) {
      calls.push(req);
      return { text: 'the answer', markdown: 'the answer', truncated: false, ...answer };
    },
  };
}

/** A client that answers with a fixed body. */
function fakeClient(response: ApiHttpResponse): ApiHttpClient {
  return {
    async request() {
      return response;
    },
  };
}

async function writeConfig(content: unknown): Promise<void> {
  await writeFile(path.join(home, 'config.json'), JSON.stringify(content), 'utf-8');
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), '10x-chat-api-'));
  process.env.TEN_X_CHAT_HOME = home;
  await mkdir(home, { recursive: true });
  await writeConfig({ providerKeys: { deepseek: 'deepseek-key' } });
  await getSecretStore().set('deepseek-key', KEY);
});

afterEach(() => {
  delete process.env.TEN_X_CHAT_HOME;
});

describe('the API transport', () => {
  it('answers without a browser and saves the response', async () => {
    const transport = fakeTransport();

    const result = await runApiChat(
      { prompt: 'hello', provider: 'deepseek' },
      { transport, client: fakeClient({ status: 200, text: '' }) },
    );

    expect(result.response).toBe('the answer');
    expect(result.truncated).toBe(false);

    const session = await getSession(result.sessionId);
    expect(session.meta.status).toBe('completed');
    expect(await readFile(session.responsePath as string, 'utf-8')).toBe('the answer');
  });

  it('sends the configured credential and the prompt', async () => {
    const transport = fakeTransport();

    await runApiChat({ prompt: 'hello', provider: 'deepseek' }, { transport });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].apiKey).toBe(KEY);
    expect(transport.calls[0].prompt).toContain('hello');
  });

  it('names a missing credential', async () => {
    await writeConfig({});

    const error = await runApiChat({ prompt: 'hello', provider: 'deepseek' }).catch(
      (err: unknown) => err as Error,
    );

    expect(failureKind(error)).toBe('missing-credential');
    expect(error.message).toContain('providerKeys.deepseek');
    expect(error.message).not.toContain(KEY);
  });

  it('rejects an attachment instead of dropping it', async () => {
    const transport = fakeTransport();

    const error = await runApiChat(
      { prompt: 'hello', provider: 'deepseek', attach: ['file.png'] },
      { transport },
    ).catch((err: unknown) => err as Error);

    expect(error.message).toMatch(/does not support attachments/);
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects a browser flag instead of ignoring it', async () => {
    const transport = fakeTransport();

    const error = await runApiChat(
      { prompt: 'hello', provider: 'deepseek', headed: true },
      { transport },
    ).catch((err: unknown) => err as Error);

    expect(error.message).toMatch(/does not use a browser/);
    expect(transport.calls).toHaveLength(0);
  });

  it('reports a rejected credential', async () => {
    const error = await runApiChat(
      { prompt: 'hello', provider: 'deepseek' },
      { client: fakeClient({ status: 401, text: '{"error":{"message":"invalid key"}}' }) },
    ).catch((err: unknown) => err as Error);

    expect(failureKind(error)).toBe('unauthorized');
    expect(error.message).toContain('401');
  });

  it('reports a broken server', async () => {
    const error = await runApiChat(
      { prompt: 'hello', provider: 'deepseek' },
      { client: fakeClient({ status: 503, text: 'unavailable' }) },
    ).catch((err: unknown) => err as Error);

    expect(failureKind(error)).toBe('unavailable');
  });

  it('reports a malformed answer', async () => {
    const error = await runApiChat(
      { prompt: 'hello', provider: 'deepseek' },
      { client: fakeClient({ status: 200, text: 'not json' }) },
    ).catch((err: unknown) => err as Error);

    expect(error.message).toMatch(/malformed/i);
  });

  it('reports a timeout', async () => {
    const client: ApiHttpClient = {
      async request() {
        throw new Error('apiRequestContext.fetch: Timeout 1000ms exceeded.');
      },
    };

    const error = await runApiChat({ prompt: 'hello', provider: 'deepseek' }, { client }).catch(
      (err: unknown) => err as Error,
    );

    expect(error.message).toMatch(/timeout/i);
    const sessions = await listSessions();
    expect(sessions[0].status).toBe('timeout');
  });

  it('never puts the credential into an error', async () => {
    const transport: ApiTransport = {
      capabilities: { attachments: false, streaming: false, cancellation: false },
      async send() {
        throw new Error(`the provider answered with ${KEY}`);
      },
    };

    const error = await runApiChat({ prompt: 'hello', provider: 'deepseek' }, { transport }).catch(
      (err: unknown) => err as Error,
    );

    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('***');
  });
});

describe('the selection of the transport', () => {
  it('keeps the browser as the default', () => {
    expect(resolveTransport({ prompt: 'hello' })).toBe('browser');
    expect(resolveTransport({ prompt: 'hello', transport: 'api' })).toBe('api');
  });

  it('runs the API transport when it is selected', async () => {
    const transport = fakeTransport();

    const result = await runChat(
      { prompt: 'hello', provider: 'deepseek', transport: 'api' },
      { transport },
    );

    expect(result.response).toBe('the answer');
  });
});

describe('the DeepSeek API transport', () => {
  it('sends the credential, the model and the prompt', async () => {
    const calls: { url: string; headers?: Record<string, string>; body?: string }[] = [];
    const client: ApiHttpClient = {
      async request(req) {
        calls.push({ url: req.url, headers: req.headers, body: req.body });
        return {
          status: 200,
          text: JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }],
          }),
        };
      },
    };

    const captured = await deepseekApiTransport.send({
      prompt: 'hello',
      model: 'deepseek-reasoner',
      apiKey: KEY,
      timeoutMs: 1000,
      client,
    });

    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0].headers?.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(captured.text).toBe('the answer');
    expect(captured.truncated).toBe(false);
  });

  it('marks an answer that the API cut off as truncated', async () => {
    const client = fakeClient({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: 'half' }, finish_reason: 'length' }],
      }),
    });

    const captured = await deepseekApiTransport.send({
      prompt: 'hello',
      apiKey: KEY,
      timeoutMs: 1000,
      client,
    });

    expect(captured.truncated).toBe(true);
  });

  it('names the status of an error answer', async () => {
    const client = fakeClient({ status: 429, text: '{"error":{"message":"rate limit"}}' });

    const error = await deepseekApiTransport
      .send({ prompt: 'hello', apiKey: KEY, timeoutMs: 1000, client })
      .catch((err: unknown) => err as Error);

    expect(error.message).toContain('429');
    expect(error.message).toContain('rate limit');
    expect(error.message).not.toContain(KEY);
  });
});
