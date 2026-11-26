import { describe, expect, it } from 'vitest';
import { publicSessionId, publicText, sanitizeReport } from '../spike/acp/sanitize.mjs';

describe('publicText', () => {
  it('replaces a session id with a stable placeholder', () => {
    const id = 'mvs_0123456789abcdef0123456789abcdef';
    const once = publicText(`session ${id}`);
    const twice = publicText(`session ${id}`);
    expect(once).not.toContain(id);
    expect(once).toBe(twice);
    expect(once).toMatch(/mvs_[0-9a-f]{8}/);
  });

  it('keeps two different session ids apart', () => {
    const a = publicText('mvs_0123456789abcdef0123456789abcdef');
    const b = publicText('mvs_0123456789abcdef0123456789abcde0');
    expect(a).not.toBe(b);
  });

  it('replaces the whole name of a percent encoded provider account', () => {
    const text = publicText('m:custom_provider%3Amy%20private%20account:v:model');
    expect(text).not.toContain('private');
    expect(text).not.toContain('my%20');
    expect(text).toContain('custom_provider%3A<provider>');
  });

  it('replaces the whole name of a plain provider account', () => {
    const text = publicText('custom_provider:my-account:v:model');
    expect(text).not.toContain('my-account');
    expect(text).toContain('custom_provider:<provider>');
  });

  it('hides the home directory of the machine', () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    expect(publicText(`${home}/.cache/secret.txt`)).toBe('~/.cache/secret.txt');
  });
});

describe('sanitizeReport', () => {
  it('walks the report and replaces every string', () => {
    const report = {
      meta: { workdir: '/some/where', ids: ['mvs_0123456789abcdef0123456789abcdef'] },
      steps: [{ note: 'custom_provider:my-account' }],
    };
    const out = sanitizeReport(report);
    expect(out.meta.workdir).toBe('<path>');
    expect(out.meta.ids[0]).toMatch(/mvs_[0-9a-f]{8}/);
    expect(out.steps[0].note).toBe('custom_provider:<provider>');
  });
});

describe('publicSessionId', () => {
  it('leaves a value that is not a session id alone', () => {
    expect(publicSessionId('not-an-id')).toBe('not-an-id');
  });
});
