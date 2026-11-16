import { describe, expect, it } from 'vitest';
import {
  envInfo,
  harnessSettings,
  publicPath,
  REPO_ROOT,
  sanitizeNoProxy,
  sanitizeProxyUrl,
} from '../spike/readiness/util.mjs';

const SECRET = 'sup3r-s3cret';
const LOGIN = 'proxy-user';

describe('sanitizeProxyUrl', () => {
  it('masks the credentials of a proxy URL', () => {
    const sanitized = sanitizeProxyUrl(`http://${LOGIN}:${SECRET}@proxy.example.com:3128`);
    expect(sanitized).toBe('http://***@proxy.example.com:3128');
    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).not.toContain(LOGIN);
  });

  it('masks the credentials of a URL without a scheme', () => {
    expect(sanitizeProxyUrl(`${LOGIN}:${SECRET}@proxy.example.com:3128`)).toBe(
      '***@proxy.example.com:3128',
    );
  });

  it('keeps a proxy URL without credentials readable', () => {
    expect(sanitizeProxyUrl('http://127.0.0.1:3128')).toBe('http://127.0.0.1:3128');
    expect(sanitizeProxyUrl(null)).toBeNull();
    expect(sanitizeProxyUrl(undefined)).toBeNull();
  });

  it('does not touch a string without a userinfo', () => {
    expect(sanitizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });
});

describe('sanitizeNoProxy', () => {
  it('sanitizes every entry of the bypass list', () => {
    const sanitized = sanitizeNoProxy(`localhost,127.0.0.1,http://${LOGIN}:${SECRET}@proxy.local`);
    expect(sanitized).toBe('localhost,127.0.0.1,http://***@proxy.local');
    expect(sanitized).not.toContain(SECRET);
  });
});

describe('envInfo', () => {
  it('publishes no proxy credentials', () => {
    const previous = {
      https: process.env.HTTPS_PROXY,
      http: process.env.HTTP_PROXY,
      no: process.env.NO_PROXY,
    };
    process.env.HTTPS_PROXY = `http://${LOGIN}:${SECRET}@proxy.example.com:3128`;
    process.env.HTTP_PROXY = `http://${LOGIN}:${SECRET}@proxy.example.com:3128`;
    process.env.NO_PROXY = `localhost,http://${LOGIN}:${SECRET}@proxy.example.com`;
    try {
      const env = envInfo();
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(LOGIN);
      expect(env.proxyEnv.HTTPS_PROXY).toBe('http://***@proxy.example.com:3128');
      expect(env.proxyEnv.NO_PROXY).toBe('localhost,http://***@proxy.example.com');
    } finally {
      for (const [key, value] of [
        ['HTTPS_PROXY', previous.https],
        ['HTTP_PROXY', previous.http],
        ['NO_PROXY', previous.no],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('publishes no hostname and no absolute path of the machine', () => {
    const env = envInfo();
    const serialized = JSON.stringify(env);
    expect('host' in env).toBe(false);
    expect(serialized).not.toContain(process.env.HOME ?? '/root');
    for (const source of Object.values(env.versionSources)) {
      if (!source) continue;
      expect(source.startsWith('/')).toBe(false);
    }
  });
});

describe('publicPath', () => {
  it('makes a path inside the repository relative', () => {
    expect(publicPath(`${REPO_ROOT}/spike/readiness/util.mjs`)).toBe('spike/readiness/util.mjs');
  });

  it('hides the name of the user in a path outside the repository', () => {
    const home = process.env.HOME ?? '';
    expect(publicPath(`${home}/.10x-chat/profiles/default`)).toBe('~/.10x-chat/profiles/default');
  });
});

describe('harnessSettings', () => {
  it('never publishes the credentials of the proxy', () => {
    const previous = process.env.SPIKE_PROXY;
    process.env.SPIKE_PROXY = `http://${LOGIN}:${SECRET}@proxy.example.com:3128`;
    try {
      const settings = harnessSettings('provider-matrix');
      expect(settings.proxy).toBe('http://***@proxy.example.com:3128');
      expect(JSON.stringify(settings)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.SPIKE_PROXY;
      else process.env.SPIKE_PROXY = previous;
    }
  });
});
