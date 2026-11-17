import { describe, expect, it } from 'vitest';
import { buildLaunchOptions } from '../src/browser/engine.js';
import {
  browserProcessEnv,
  proxyFingerprint,
  proxyFromEnv,
  proxyLaunchOptions,
  splitProxyCredentials,
} from '../src/browser/proxy.js';

const SECRET = 'sup3r-s3cret';
const LOGIN = 'proxy-user';

describe('splitProxyCredentials', () => {
  it('separates the credentials from the server URL', () => {
    const proxy = splitProxyCredentials(`http://${LOGIN}:${SECRET}@proxy.example.com:3128`);
    expect(proxy.server).toBe('http://proxy.example.com:3128');
    expect(proxy.username).toBe(LOGIN);
    expect(proxy.password).toBe(SECRET);
  });

  it('never keeps the userinfo in the server URL', () => {
    const proxy = splitProxyCredentials(`https://${LOGIN}:${SECRET}@proxy.example.com:8443`);
    expect(proxy.server).not.toContain(LOGIN);
    expect(proxy.server).not.toContain(SECRET);
    expect(proxy.server).not.toContain('@');
  });

  it('parses a URL without a scheme', () => {
    const proxy = splitProxyCredentials(`${LOGIN}:${SECRET}@proxy.example.com:3128`);
    expect(proxy.server).toBe('http://proxy.example.com:3128');
    expect(proxy.username).toBe(LOGIN);
    expect(proxy.password).toBe(SECRET);
  });

  it('keeps a proxy URL without credentials unchanged', () => {
    expect(splitProxyCredentials('http://127.0.0.1:3128')).toEqual({
      server: 'http://127.0.0.1:3128',
    });
    expect(splitProxyCredentials('127.0.0.1:3128')).toEqual({ server: '127.0.0.1:3128' });
  });

  it('decodes percent-encoded credentials', () => {
    const proxy = splitProxyCredentials(
      `http://${encodeURIComponent(LOGIN)}:${encodeURIComponent(SECRET)}@proxy.example.com:3128`,
    );
    expect(proxy.username).toBe(LOGIN);
    expect(proxy.password).toBe(SECRET);
  });

  it('keeps an IPv6 host readable', () => {
    const proxy = splitProxyCredentials(`http://${LOGIN}:${SECRET}@[::1]:3128`);
    expect(proxy.server).toBe('http://[::1]:3128');
  });

  it('handles a user without a password', () => {
    const proxy = splitProxyCredentials(`http://${LOGIN}@proxy.example.com:3128`);
    expect(proxy.server).toBe('http://proxy.example.com:3128');
    expect(proxy.username).toBe(LOGIN);
    expect(proxy.password).toBeUndefined();
  });
});

describe('proxyFromEnv', () => {
  it('reads HTTPS_PROXY first', () => {
    const proxy = proxyFromEnv({
      HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
      HTTP_PROXY: 'http://other.example.com:3128',
    });
    expect(proxy?.server).toBe('http://proxy.example.com:3128');
    expect(proxy?.password).toBe(SECRET);
  });

  it('falls back to HTTP_PROXY', () => {
    const proxy = proxyFromEnv({ HTTP_PROXY: 'http://127.0.0.1:3128' });
    expect(proxy?.server).toBe('http://127.0.0.1:3128');
  });

  it('falls back to the lowercase variables', () => {
    expect(proxyFromEnv({ https_proxy: 'http://lower.example.com:3128' })?.server).toBe(
      'http://lower.example.com:3128',
    );
    expect(proxyFromEnv({ http_proxy: 'http://lower.example.com:3128' })?.server).toBe(
      'http://lower.example.com:3128',
    );
  });

  it('falls back to ALL_PROXY', () => {
    const proxy = proxyFromEnv({ ALL_PROXY: 'http://all.example.com:3128' });
    expect(proxy?.server).toBe('http://all.example.com:3128');
  });

  it('uses the first variable of the precedence list', () => {
    const proxy = proxyFromEnv({
      HTTPS_PROXY: 'http://first.example.com:3128',
      https_proxy: 'http://second.example.com:3128',
      HTTP_PROXY: 'http://third.example.com:3128',
    });
    expect(proxy?.server).toBe('http://first.example.com:3128');
  });

  it('turns NO_PROXY into a bypass list', () => {
    const proxy = proxyFromEnv({
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      NO_PROXY: 'localhost, 127.0.0.1 ,',
    });
    expect(proxy?.bypass).toBe('localhost,127.0.0.1');
  });

  it('reads the lowercase bypass list', () => {
    const proxy = proxyFromEnv({
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      no_proxy: 'localhost',
    });
    expect(proxy?.bypass).toBe('localhost');
  });

  it('has no proxy without the environment variables', () => {
    expect(proxyFromEnv({})).toBeUndefined();
    expect(proxyFromEnv({ HTTPS_PROXY: '   ' })).toBeUndefined();
  });
});

describe('browserProcessEnv', () => {
  it('drops every proxy variable', () => {
    const env = browserProcessEnv({
      HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
      HTTP_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
      ALL_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
      https_proxy: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
      HOME: '/home/user',
      DISPLAY: ':99',
    });
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
  });

  it('keeps everything else', () => {
    const env = browserProcessEnv({ HOME: '/home/user', DISPLAY: ':99' });
    expect(env).toEqual({ HOME: '/home/user', DISPLAY: ':99' });
  });
});

describe('proxyLaunchOptions', () => {
  it('hands the credentials to Playwright, not to the command line', () => {
    const options = proxyLaunchOptions({
      server: 'http://proxy.example.com:3128',
      username: LOGIN,
      password: SECRET,
      bypass: 'localhost',
    });
    expect(options.proxy.server).toBe('http://proxy.example.com:3128');
    expect(options.proxy.server).not.toContain(SECRET);
    expect(options.proxy.username).toBe(LOGIN);
    expect(options.proxy.password).toBe(SECRET);
    expect(options.proxy.bypass).toBe('localhost');
  });

  it('refuses SOCKS proxies with credentials', () => {
    expect(() =>
      proxyLaunchOptions({
        server: 'socks5://proxy.example.com:1080',
        username: LOGIN,
        password: SECRET,
      }),
    ).toThrow(/SOCKS proxy authentication/);
  });

  it('allows SOCKS proxies without credentials', () => {
    const options = proxyLaunchOptions({ server: 'socks5://proxy.example.com:1080' });
    expect(options.proxy.server).toBe('socks5://proxy.example.com:1080');
    expect(options.proxy.username).toBeUndefined();
  });

  it('refuses SOCKS4 proxies with credentials', () => {
    expect(() =>
      proxyLaunchOptions({
        server: 'socks4://proxy.example.com:1080',
        username: LOGIN,
        password: SECRET,
      }),
    ).toThrow(/SOCKS proxy authentication/);
  });

  it('refuses an unsupported scheme', () => {
    expect(() => proxyLaunchOptions({ server: 'ftp://proxy.example.com:21' })).toThrow(
      /Unsupported proxy scheme "ftp"/,
    );
  });

  it('never puts the credentials into the error message', () => {
    try {
      proxyLaunchOptions({
        server: 'socks5://proxy.example.com:1080',
        username: LOGIN,
        password: SECRET,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it('never puts the credentials of a malformed URL into the error message', () => {
    for (const raw of [
      `ftp://${LOGIN}:${SECRET}@host:badport`,
      `http://${LOGIN}:${SECRET}@host:badport`,
      `${LOGIN}:${SECRET}@host:badport`,
    ]) {
      try {
        proxyLaunchOptions(splitProxyCredentials(raw));
        expect.unreachable();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(LOGIN);
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain(raw);
      }
    }
  });

  it('names the scheme of a malformed URL, not the URL', () => {
    try {
      proxyLaunchOptions(splitProxyCredentials(`ftp://${LOGIN}:${SECRET}@host:badport`));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/Unsupported proxy scheme "ftp"/);
    }
  });

  it('reports a URL that cannot be parsed without naming it', () => {
    try {
      proxyLaunchOptions(splitProxyCredentials(`http://${LOGIN}:${SECRET}@host:badport`));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/Invalid proxy URL/);
    }
  });

  it('keeps the credentials out of the server URL of a malformed URL', () => {
    const proxy = splitProxyCredentials(`ftp://${LOGIN}:${SECRET}@host:badport`);
    expect(proxy.server).not.toContain(LOGIN);
    expect(proxy.server).not.toContain(SECRET);
  });
});

describe('proxyFingerprint', () => {
  it('is stable for the same proxy', () => {
    const env = { HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128` };
    expect(proxyFingerprint(env)).toBe(proxyFingerprint(env));
  });

  it('changes with the proxy', () => {
    const a = proxyFingerprint({ HTTPS_PROXY: 'http://a.example.com:3128' });
    const b = proxyFingerprint({ HTTPS_PROXY: 'http://b.example.com:3128' });
    const c = proxyFingerprint({
      HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
    });
    const d = proxyFingerprint({
      HTTPS_PROXY: `http://${LOGIN}:other@proxy.example.com:3128`,
    });
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
  });

  it('does not contain the credentials', () => {
    const fingerprint = proxyFingerprint({
      HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
    });
    expect(fingerprint).not.toContain(SECRET);
    expect(fingerprint).not.toContain(LOGIN);
  });

  it('has a value without a proxy', () => {
    expect(proxyFingerprint({})).toBe('none');
  });
});

describe('buildLaunchOptions', () => {
  const env = {
    HTTPS_PROXY: `http://${LOGIN}:${SECRET}@proxy.example.com:3128`,
    NO_PROXY: 'localhost',
    HOME: '/home/user',
  };

  it('puts the proxy into the Playwright launch options', () => {
    const options = buildLaunchOptions({ headless: true, args: ['--no-first-run'] }, env);
    const launchOptions = options.launchOptions as {
      proxy: { server: string; username: string; password: string; bypass: string };
      env: Record<string, string>;
    };
    expect(launchOptions.proxy.server).toBe('http://proxy.example.com:3128');
    expect(launchOptions.proxy.password).toBe(SECRET);
    expect(launchOptions.proxy.bypass).toBe('localhost');
  });

  it('keeps the credentials out of the browser arguments', () => {
    const options = buildLaunchOptions({ headless: true, args: ['--no-first-run'] }, env);
    const args = (options.args as string[]) ?? [];
    expect(args.join(' ')).not.toContain(SECRET);
    expect(args.some((arg) => arg.startsWith('--proxy-server'))).toBe(false);
  });

  it('keeps the credentials out of the browser environment', () => {
    const options = buildLaunchOptions({ headless: true }, env);
    const launchOptions = options.launchOptions as { env: Record<string, string> };
    expect(JSON.stringify(launchOptions.env)).not.toContain(SECRET);
    expect(launchOptions.env.HTTPS_PROXY).toBeUndefined();
    expect(launchOptions.env.HOME).toBe('/home/user');
  });

  it('drops the chrome channel CloakBrowser does not support', () => {
    const options = buildLaunchOptions({ channel: 'chrome' }, env);
    expect(options.channel).toBeUndefined();
  });

  it('drops the proxy variables from the environment even without a configured proxy', () => {
    const options = buildLaunchOptions(
      { headless: true },
      { ALL_PROXY: `http://${LOGIN}:${SECRET}@p:3128` },
    );
    const launchOptions = options.launchOptions as {
      env: Record<string, string>;
      proxy?: unknown;
    };
    expect(launchOptions.env.ALL_PROXY).toBeUndefined();
    expect(JSON.stringify(launchOptions.env)).not.toContain(SECRET);
  });

  it('keeps the other options untouched without a proxy', () => {
    const options = buildLaunchOptions({ headless: true }, {});
    expect(options.headless).toBe(true);
    expect(options.channel).toBeUndefined();
  });
});
