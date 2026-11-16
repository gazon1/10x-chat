import { describe, expect, it } from 'vitest';
import { compatibilityIssues, savedSettings } from '../spike/readiness/report-compat.mjs';

// The expected settings come from the environment of the harness run.
process.env.SPIKE_HEADLESS = '1';

const env = {
  node: 'v22.22.2',
  platform: 'Linux 6.0 x64',
  camoufoxPackage: '0.5.9',
  playwrightCoreSpike: '1.62.0',
  cloakbrowser: '0.4.10',
  proxyEnv: { HTTPS_PROXY: null, HTTP_PROXY: null, NO_PROXY: null },
};

describe('savedSettings', () => {
  it('prefers the harness block', () => {
    const settings = savedSettings('provider-matrix', {
      harness: { proxy: 'http://p:1', headless: true },
      proxy: 'http://old:2',
    });
    expect(settings.proxy).toBe('http://p:1');
  });

  it('falls back to the top-level values of the provider matrix', () => {
    const settings = savedSettings('provider-matrix', {
      proxy: 'http://p:1',
      headless: true,
    });
    expect(settings).toEqual({ proxy: 'http://p:1', headless: true });
  });
});

describe('compatibilityIssues', () => {
  it('accepts a report produced with the same versions and settings', () => {
    const report = {
      env,
      harness: { proxy: 'http://127.0.0.1:3128', headless: true },
    };
    expect(compatibilityIssues('provider-matrix', report, env)).toEqual([]);
  });

  it('rejects a report of another version', () => {
    const report = {
      env: { ...env, camoufoxPackage: '0.5.8' },
      harness: { proxy: 'http://127.0.0.1:3128', headless: true },
    };
    const issues = compatibilityIssues('provider-matrix', report, env);
    expect(issues.join(' ')).toContain('camoufoxPackage');
  });

  it('rejects a report with a different proxy', () => {
    const report = {
      env,
      harness: { proxy: 'http://127.0.0.1:9999', headless: true },
    };
    const issues = compatibilityIssues('provider-matrix', report, env);
    expect(issues.join(' ')).toContain('proxy');
  });

  it('rejects a report with a different headless setting', () => {
    const report = {
      env,
      harness: { proxy: 'http://127.0.0.1:3128', headless: false },
    };
    const issues = compatibilityIssues('provider-matrix', report, env);
    expect(issues.join(' ')).toContain('headless');
  });

  it('rejects a partial or reduced report', () => {
    expect(compatibilityIssues('provider-matrix', { partial: true }, env).join(' ')).toContain(
      'partial',
    );
    expect(compatibilityIssues('provider-matrix', { reduced: true }, env).join(' ')).toContain(
      'reduced',
    );
  });

  // The versions of the packages the harness really uses: a change of any of
  // them means the report describes another experiment.
  for (const key of ['camoufoxPackage', 'playwrightCoreSpike', 'cloakbrowser']) {
    it(`detects a change of ${key}`, () => {
      const report = {
        env: { ...env, [key]: '0.0.1' },
        harness: { proxy: 'http://127.0.0.1:3128', headless: true },
      };
      const issues = compatibilityIssues('provider-matrix', report, env);
      expect(issues.join(' ')).toContain(key);
    });

    it(`detects that ${key} cannot be resolved any more`, () => {
      const report = {
        env: { ...env, [key]: '0.0.1' },
        harness: { proxy: 'http://127.0.0.1:3128', headless: true },
      };
      const issues = compatibilityIssues('provider-matrix', report, { ...env, [key]: null });
      expect(issues.join(' ')).toContain(key);
    });

    it(`detects that ${key} was not recorded in the report`, () => {
      const report = {
        env: { ...env, [key]: null },
        harness: { proxy: 'http://127.0.0.1:3128', headless: true },
      };
      const issues = compatibilityIssues('provider-matrix', report, env);
      expect(issues.join(' ')).toContain(key);
    });
  }

  it('detects a changed browser build', () => {
    const report = {
      env: { ...env, camoufoxBrowser: '158.0.1-beta.41' },
      harness: { proxy: 'http://127.0.0.1:3128', headless: true },
    };
    const issues = compatibilityIssues('provider-matrix', report, {
      ...env,
      camoufoxBrowser: '159.0.0-beta.42',
    });
    expect(issues.join(' ')).toContain('camoufoxBrowser');
  });
});
