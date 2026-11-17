import { describe, expect, it, vi } from 'vitest';

const { fetchMock, disposeMock, newContextMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  disposeMock: vi.fn(),
  newContextMock: vi.fn(),
}));

vi.mock('playwright', () => ({
  request: { newContext: newContextMock },
}));

const { createApiHttpClient } = await import('../src/transport/http.js');

describe('the HTTP client of the API transports', () => {
  it('sends the request through the effective proxy', async () => {
    newContextMock.mockResolvedValue({
      fetch: fetchMock,
      dispose: disposeMock,
    });
    fetchMock.mockResolvedValue({ status: () => 200, text: async () => 'the body' });

    const client = createApiHttpClient({
      server: 'http://proxy.example:3128',
      username: 'the-user',
      password: 'the-password',
    });

    const response = await client.request({
      url: 'https://api.example/v1/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"prompt":"hello"}',
      timeoutMs: 1234,
    });

    expect(newContextMock).toHaveBeenCalledWith({
      proxy: {
        server: 'http://proxy.example:3128',
        username: 'the-user',
        password: 'the-password',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: '{"prompt":"hello"}',
      timeout: 1234,
    });
    expect(response).toEqual({ status: 200, text: 'the body' });
    expect(disposeMock).toHaveBeenCalled();
  });

  it('works without a proxy', async () => {
    newContextMock.mockResolvedValue({
      fetch: fetchMock,
      dispose: disposeMock,
    });
    fetchMock.mockResolvedValue({ status: () => 204, text: async () => '' });

    const client = createApiHttpClient(null);
    await client.request({ url: 'https://api.example/v1/chat', timeoutMs: 1000 });

    expect(newContextMock).toHaveBeenCalledWith({});
  });
});
