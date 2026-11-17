import { describe, expect, it } from 'vitest';
import { browserError, redactText, redactValue, sanitizeUrl } from '../src/browser/diagnostics.js';

describe('browser diagnostics redaction', () => {
  it('sanitizes URLs by removing secrets and query/hash', () => {
    expect(sanitizeUrl('https://user:pass@example.com/path/to/chat?token=abc#frag')).toBe(
      'https://example.com/path/to/chat',
    );
  });

  it('redacts sensitive values and local home paths from text', () => {
    const home = process.env.HOME ?? '/home/test';
    const input = `Authorization: Bearer secret123 cookie=session=abc token=xyz api_key=abc123 ${home}/.10x-chat/profiles/default`;
    const redacted = redactText(input);
    expect(redacted).not.toContain('secret123');
    expect(redacted).not.toContain('session=abc');
    expect(redacted).not.toContain('token=xyz');
    expect(redacted).not.toContain('abc123');
    expect(redacted).toContain('[REDACTED]');
    if (process.env.HOME) expect(redacted).toContain('~/.10x-chat/profiles/default');

    expect(redactText('authorization:    BEARER   spacedsecret')).not.toContain('spacedsecret');
    expect(redactText('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
    expect(redactText('AUTHORIZATION=Bearer mixedCaseSecret')).not.toContain('mixedCaseSecret');
  });

  it('redacts the credentials of a proxy URL', () => {
    const redacted = redactText('proxy http://proxy-user:sup3r-s3cret@proxy.example.com:3128');
    expect(redacted).not.toContain('sup3r-s3cret');
    expect(redacted).not.toContain('proxy-user');
    expect(redacted).toContain('proxy.example.com:3128');
  });

  it('keeps a URL without credentials readable', () => {
    expect(redactText('https://chatgpt.com/c/123')).toBe('https://chatgpt.com/c/123');
  });

  it('redacts secret object keys recursively', () => {
    const value = redactValue({
      authorization: 'Bearer secret',
      nested: { cookie: 'a=b', prompt: 'private prompt', ok: 'safe' },
      path: `${process.env.HOME ?? '/home/test'}/file`,
    }) as {
      authorization: string;
      nested: { cookie: string; prompt: string; ok: string };
      path: string;
    };
    expect(value.authorization).toBe('[REDACTED]');
    expect(value.nested.cookie).toBe('[REDACTED]');
    expect(value.nested.prompt).toBe('[REDACTED]');
    expect(value.nested.ok).toBe('safe');
    if (process.env.HOME) expect(value.path).toContain('~/file');
  });

  it('formats structured browser errors without leaking secrets in the cause chain', () => {
    const home = process.env.HOME;
    const stackPath = `${home ?? '/tmp/home'}/secret/path.ts:1:1`;
    const cause = new Error('Authorization: Bearer topsecret');
    cause.stack = `Error: Authorization: Bearer topsecret\n    at fn (${stackPath})`;
    (cause as Error & { cause?: unknown }).cause = new Error(
      'nested cookie=session=abc password=hunter2',
    );

    const err = browserError(
      'Failed during request',
      {
        provider: 'chatgpt',
        operation: 'chat',
        stage: 'submit-prompt',
        url: 'https://chatgpt.com/c/123?token=leak',
        startedAt: Date.now() - 25,
      },
      cause,
    ) as Error & { cause?: unknown };

    expect(err.message).toContain('provider=chatgpt');
    expect(err.message).toContain('operation=chat');
    expect(err.message).toContain('stage=submit-prompt');
    expect(err.message).toContain('url=https://chatgpt.com/c/123');
    expect(err.message).toContain('elapsedMs=');
    expect(err.message).not.toContain('token=leak');
    expect(err.message).not.toContain('topsecret');
    expect(err.message).not.toContain('session=abc');

    expect(err.cause).toBeInstanceOf(Error);
    const c1 = err.cause as Error & { cause?: unknown };
    expect(c1).not.toBe(cause);
    expect(c1.message).not.toContain('topsecret');
    expect(String(c1.stack ?? '')).not.toContain('topsecret');
    if (home) expect(String(c1.stack ?? '')).not.toContain(home);

    expect(c1.cause).toBeInstanceOf(Error);
    const c2 = c1.cause as Error;
    expect(c2).not.toBe((cause as Error & { cause?: unknown }).cause);
    expect(c2.message).not.toContain('session=abc');
    expect(c2.message).not.toContain('hunter2');
    expect(c2.message).toContain('[REDACTED]');
  });
});
