import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { getAppDir } from '../paths.js';

export const BROWSER_DEBUG_ENV = 'TEN_X_CHAT_BROWSER_DEBUG';
const SECRET_KEYS = /(^|_)(token|cookie|authorization|password|secret|prompt|session|auth)(_|$)/i;
const HOME = process.env.HOME ?? '';

export interface BrowserOp {
  provider?: string;
  operation: string;
  stage?: string;
  url?: string;
  startedAt?: number;
}

export function isBrowserDebugEnabled(): boolean {
  const v = process.env[BROWSER_DEBUG_ENV];
  return v === '1' || v === 'true';
}

export function sanitizeUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

export function redactPath(value: string): string {
  if (!HOME) return value;
  return value.split(HOME).join('~');
}

export function redactText(value: string): string {
  let out = value;
  if (HOME) out = out.split(HOME).join('~');
  out = out.replace(
    /(authorization\s*[:=]\s*)(?:(?:basic|bearer|digest|token)\s+)*[^\s,"']+/gi,
    '$1[REDACTED]',
  );
  out = out.replace(/(cookie\s*[:=]\s*)([^\s"']+)/gi, '$1[REDACTED]');
  out = out.replace(
    /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,"']+)/gi,
    '$1[REDACTED]',
  );
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
      else out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function formatOp(op: BrowserOp): string {
  const parts = [
    op.provider ? `provider=${op.provider}` : null,
    `operation=${op.operation}`,
    op.stage ? `stage=${op.stage}` : null,
    op.url ? `url=${sanitizeUrl(op.url) ?? '[invalid-url]'}` : null,
    op.startedAt ? `elapsedMs=${Date.now() - op.startedAt}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

function sanitizeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const safe = new Error(redactText(cause.message));
    safe.name = cause.name || 'Error';
    if (cause.stack) safe.stack = redactText(cause.stack);
    const nested = (cause as Error & { cause?: unknown }).cause;
    if (nested != null) (safe as Error & { cause?: unknown }).cause = sanitizeCause(nested);
    return safe;
  }
  if (cause != null) return redactText(String(cause));
  return undefined;
}

export function browserError(message: string, op: BrowserOp, cause?: unknown): Error {
  const base = redactText(message);
  const causeMsg =
    cause instanceof Error
      ? redactText(cause.message)
      : cause != null
        ? redactText(String(cause))
        : '';
  const detail = causeMsg && causeMsg !== base ? `: ${causeMsg}` : '';
  const err = new Error(`${base} (${formatOp(op)})${detail}`);
  const safeCause = sanitizeCause(cause);
  if (safeCause != null) (err as Error & { cause?: unknown }).cause = safeCause;
  return err;
}

export interface DebugCollector {
  attach(page: Page): void;
  dump(): Promise<Record<string, unknown>>;
}

export function createDebugCollector(): DebugCollector {
  const consoleLogs: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const push = <T>(arr: T[], item: T, max = 200) => {
    if (arr.length < max) arr.push(item);
  };
  return {
    attach(page: Page) {
      page.on('console', (msg) => {
        push(consoleLogs, { type: msg.type(), text: redactText(msg.text()).slice(0, 500) });
      });
      page.on('pageerror', (err) => {
        push(pageErrors, redactText(err.message).slice(0, 500));
      });
      page.on('requestfailed', (req) => {
        const failure = req.failure()?.errorText ?? 'failed';
        push(
          requestFailures,
          `${req.method()} ${sanitizeUrl(req.url()) ?? '[url]'} ${redactText(failure)}`,
        );
      });
    },
    async dump() {
      return {
        console: consoleLogs,
        pageErrors,
        requestFailures,
      };
    },
  };
}

function safeSlug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'op'
  );
}

export async function saveDebugArtifacts(
  op: BrowserOp,
  page: Page | undefined,
  context: BrowserContext | undefined,
  collector: DebugCollector | undefined,
): Promise<string | undefined> {
  if (!isBrowserDebugEnabled()) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(
    getAppDir(),
    'debug',
    `${stamp}-${safeSlug(op.provider ?? 'browser')}-${safeSlug(op.operation)}`,
  );
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const meta = {
      ...op,
      url: sanitizeUrl(op.url),
      startedAt: op.startedAt ? new Date(op.startedAt).toISOString() : undefined,
      finishedAt: new Date().toISOString(),
      elapsedMs: op.startedAt ? Date.now() - op.startedAt : undefined,
    };
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    if (collector) {
      await writeFile(
        path.join(dir, 'events.json'),
        JSON.stringify(await collector.dump(), null, 2),
      );
    }
    if (page) {
      await page
        .screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true })
        .catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) await writeFile(path.join(dir, 'page.html'), redactText(html).slice(0, 500_000));
    }
    return dir;
  } catch {
    return undefined;
  }
}
