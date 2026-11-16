import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envInfo, REPO_ROOT } from '../spike/readiness/util.mjs';

const CAMOUFOX_SANDBOX = path.join(REPO_ROOT, 'spike', 'camoufox', 'node_modules');

function versionOf(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

describe('envInfo', () => {
  const env = envInfo();

  it('resolves the versions from the packages that are really used', () => {
    // CloakBrowser and the repository's Playwright live in the repository.
    expect(env.cloakbrowser).toBe(versionOf(path.join(REPO_ROOT, 'node_modules', 'cloakbrowser')));
    expect(env.playwrightCoreRepo).toBe(
      versionOf(path.join(REPO_ROOT, 'node_modules', 'playwright-core')),
    );
  });

  it('resolves Camoufox and its Playwright from the nested sandbox', () => {
    const camoufox = versionOf(path.join(CAMOUFOX_SANDBOX, 'camoufox'));
    const playwright = versionOf(path.join(CAMOUFOX_SANDBOX, 'playwright-core'));
    if (!camoufox) {
      // The sandbox is not installed (CI installs the repository only).
      expect(env.camoufoxPackage).toBeNull();
      expect(env.versionSources.camoufoxPackage).toBeNull();
      return;
    }
    expect(env.camoufoxPackage).toBe(camoufox);
    expect(env.playwrightCoreSpike).toBe(playwright);
    expect(env.versionSources.camoufoxPackage).toContain(
      path.join('spike', 'camoufox', 'node_modules', 'camoufox'),
    );
  });

  it('records where every version came from', () => {
    for (const key of [
      'camoufoxPackage',
      'playwrightCoreSpike',
      'playwrightCoreRepo',
      'cloakbrowser',
    ]) {
      const source = env.versionSources[key];
      if (env[key] === null) {
        expect(source).toBeNull();
      } else {
        expect(source).toBeTruthy();
        expect(existsSync(source as string)).toBe(true);
      }
    }
  });

  it('records the installed Camoufox browser build', () => {
    const config = path.join(process.env.HOME ?? '', '.cache', 'camoufox', 'config.json');
    if (!existsSync(config)) {
      expect(env.camoufoxBrowser).toBeNull();
      return;
    }
    expect(env.camoufoxBrowser).toMatch(/^\d+\.\d+\.\d+/);
    expect(env.versionSources.camoufoxBrowser).toBe(config);
  });
});
