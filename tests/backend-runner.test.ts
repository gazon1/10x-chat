import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatgptUseBackend, type ProcessRunner } from '../src/backend/chatgpt-use.js';

const { fakeBackendAsk, loadConfigMock, buildBundleMock, resolveAttachPathsMock } = vi.hoisted(
  () => ({
    fakeBackendAsk: vi.fn(),
    loadConfigMock: vi.fn(),
    buildBundleMock: vi.fn(async () => 'bundle'),
    resolveAttachPathsMock: vi.fn(async () => []),
  }),
);

vi.mock('../src/config.js', () => ({ loadConfig: loadConfigMock }));
vi.mock('../src/core/bundle.js', () => ({ buildBundle: buildBundleMock }));
vi.mock('../src/core/conversations.js', () => ({
  getStoredConversation: vi.fn(async () => undefined),
  resolveConversationContext: vi.fn(async () => ({ cwd: '/tmp', branch: 'main', repo: 'repo' })),
}));
vi.mock('../src/core/files.js', () => ({ resolveAttachPaths: resolveAttachPathsMock }));
vi.mock('../src/core/model.js', () => ({ chatModel: () => undefined }));
vi.mock('../src/paths.js', () => ({ getSessionDir: () => '/tmp/session-dir' }));
vi.mock('../src/providers/index.js', () => ({
  getProvider: () => ({ config: { defaultModel: undefined } }),
}));
vi.mock('../src/session/index.js', () => ({
  createSession: vi.fn(async () => ({ id: 'session-1' })),
  saveBundle: vi.fn(async () => undefined),
  saveResponse: vi.fn(async () => undefined),
  updateSession: vi.fn(async () => undefined),
}));

import { runBackendChat } from '../src/core/backend-runner.js';

function fakeRunner(stdout: string): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(_command, args) {
      calls.push(args);
      return { code: 0, stdout, stderr: '', timedOut: false };
    },
  };
  return { runner, calls };
}

describe('runBackendChat chatgptProject', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-backend-runner-'));
    process.env = { ...originalEnv, TEN_X_CHAT_HOME: tempHome };
    fakeBackendAsk.mockReset();
    buildBundleMock.mockClear();
    resolveAttachPathsMock.mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
  });

  it('ignores chatgptProject for non-ChatGPT providers', async () => {
    loadConfigMock.mockResolvedValue({ chatgptProject: 'chatgpt-use' });
    fakeBackendAsk.mockResolvedValue({
      ok: true,
      value: {
        requestId: 'session-1',
        text: 'ok',
        markdown: 'ok',
        truncated: false,
        submission: 'submitted',
      },
    });

    const result = await runBackendChat(
      { prompt: 'hello', provider: 'gemini' },
      {
        name: 'fake',
        capabilities: {
          attachments: false,
          streaming: false,
          cancellation: false,
          conversationReuse: false,
          modelSelection: false,
          imageOutput: false,
        },
        ask: fakeBackendAsk,
        status: async () => ({ requestId: 'session-1', submission: 'unknown' }),
        resume: async () => ({
          ok: false,
          failure: { kind: 'unavailable', message: 'no', submission: 'not_submitted' },
        }),
        cancel: async () => ({ ok: true, value: { cancelled: false } }),
      },
    );

    expect(result.response).toBe('ok');
    expect(fakeBackendAsk.mock.calls[0]?.[0]?.chatgptProject).toBeUndefined();
  });

  it('rejects a configured chatgptProject for a backend that cannot file into projects', async () => {
    loadConfigMock.mockResolvedValue({ chatgptProject: 'chatgpt-use' });

    await expect(
      runBackendChat(
        { prompt: 'hello', provider: 'chatgpt' },
        {
          name: 'other-backend',
          capabilities: {
            attachments: false,
            streaming: false,
            cancellation: false,
            conversationReuse: false,
            modelSelection: false,
            imageOutput: false,
          },
          ask: fakeBackendAsk,
          status: async () => ({ requestId: 'session-1', submission: 'unknown' }),
          resume: async () => ({
            ok: false,
            failure: { kind: 'unavailable', message: 'no', submission: 'not_submitted' },
          }),
          cancel: async () => ({ ok: true, value: { cancelled: false } }),
        },
      ),
    ).rejects.toThrow(/cannot file a new ChatGPT conversation into a project/);
    expect(fakeBackendAsk).not.toHaveBeenCalled();
  });

  it('passes chatgptProject to chatgpt-use backend requests', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-runner-projects-'));
    const projectsPath = path.join(dir, 'projects.json');
    await writeFile(
      projectsPath,
      JSON.stringify({ 'chatgpt-use': 'g-p-6afee1f89d048191922c5b25247b5a95' }),
      'utf8',
    );
    loadConfigMock.mockResolvedValue({ chatgptProject: 'chatgpt-use' });
    const { runner, calls } = fakeRunner(
      JSON.stringify({
        status: 'completed',
        request_id: 'session-1',
        conversation_id: 'conv-1',
        result: { text: 'ok' },
      }),
    );
    const backend = createChatgptUseBackend({
      runner,
      projectsPath,
      verifyProjectMembership: async () => undefined,
    });

    const result = await runBackendChat({ prompt: 'hello', provider: 'chatgpt' }, backend);

    expect(result.response).toBe('ok');
    expect(calls[0]).toContain('--project');
    expect(calls[0]?.[calls[0].indexOf('--project') + 1]).toBe('chatgpt-use');
  });
});
