/**
 * When may a saved matrix report be reused?
 *
 * A report is only reusable when it was produced with the same versions, the
 * same proxy and the same headless setting. Otherwise `run-all.mjs` re-runs
 * the matrix instead of quietly reporting another experiment's numbers.
 */
import { envInfo, harnessSettings } from './util.mjs';

/** The proxy/headless settings a report was produced with. */
export function savedSettings(name, report) {
  if (report.harness) return report.harness;
  // The provider matrix kept its settings at the top level.
  if (name === 'provider-matrix') return { proxy: report.proxy ?? null, headless: report.headless };
  return null;
}

/**
 * The facts a report depends on. A mismatch in any of them means the report
 * describes another experiment and must not be reused.
 *
 * `null` counts as a value: a report that recorded a version which cannot be
 * resolved now (or the other way round) is not comparable either — that was
 * exactly the hole the missing versions of the nested Camoufox sandbox left.
 */
export const VERSION_KEYS = [
  'node',
  'platform',
  'camoufoxPackage',
  'camoufoxBrowser',
  'camoufoxBrowserSha256',
  'playwrightCoreSpike',
  'playwrightCoreRepo',
  'cloakbrowser',
];

/**
 * Why a saved report must not be reused as-is: different versions, different
 * proxy or headless setting, or an interrupted run.
 */
export function compatibilityIssues(name, report, now = envInfo()) {
  const issues = [];
  if (report.partial) issues.push('the saved report is partial (an interrupted run)');
  if (report.reduced) issues.push('the saved report comes from a reduced (smoke) run');
  const savedEnv = report.env ?? {};
  for (const key of VERSION_KEYS) {
    const saved = savedEnv[key] ?? null;
    const current = now[key] ?? null;
    if (saved !== current) {
      issues.push(`${key}: report=${saved}, now=${current}`);
    }
  }
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    const saved = savedEnv.proxyEnv?.[key] ?? null;
    const current = now.proxyEnv?.[key] ?? null;
    if (saved !== current) issues.push(`${key}: report=${saved}, now=${current}`);
  }
  const expected = harnessSettings(name);
  const saved = savedSettings(name, report);
  if (!saved) {
    issues.push('the saved report has no harness settings to compare');
  } else {
    if ((saved.proxy ?? null) !== (expected.proxy ?? null)) {
      issues.push(`proxy: report=${saved.proxy ?? null}, now=${expected.proxy ?? null}`);
    }
    if ((saved.headless ?? null) !== (expected.headless ?? null)) {
      issues.push(`headless: report=${saved.headless ?? null}, now=${expected.headless ?? null}`);
    }
  }
  return issues;
}
