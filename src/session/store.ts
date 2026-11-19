import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSessionDir, getSessionsDir } from '../paths.js';
import { isValidProvider } from '../providers/index.js';
import type { ProviderName, SessionMeta, SessionResult, SessionStatus } from '../types.js';

const SESSION_STATUSES: readonly SessionStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'timeout',
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A session id becomes a directory name — it must not be able to escape the
 * sessions directory.
 */
function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

/** Write a file atomically (temp file + rename) — no half-written file. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a parsed metadata file is a complete session metadata.
 *
 * Every field that the CLI reads is checked: a file with an `id` and a
 * `createdAt` only would be shown with empty fields or crash on a missing
 * `promptPreview` — it must be reported as a broken session instead.
 */
function isValidSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Partial<SessionMeta>;

  if (typeof meta.id !== 'string' || meta.id === '') return false;
  if (typeof meta.provider !== 'string' || !isValidProvider(meta.provider)) return false;
  if (typeof meta.promptPreview !== 'string') return false;
  if (typeof meta.status !== 'string' || !SESSION_STATUSES.includes(meta.status)) return false;
  if (typeof meta.createdAt !== 'string' || Number.isNaN(Date.parse(meta.createdAt))) return false;
  if (typeof meta.updatedAt !== 'string' || Number.isNaN(Date.parse(meta.updatedAt))) return false;
  if (meta.model !== undefined && typeof meta.model !== 'string') return false;
  if (meta.backend !== undefined && typeof meta.backend !== 'string') return false;
  if (
    meta.durationMs !== undefined &&
    (typeof meta.durationMs !== 'number' || !Number.isFinite(meta.durationMs))
  ) {
    return false;
  }
  return true;
}

/**
 * Read the metadata of a session.
 *
 * A missing or broken session is an error that names the file — a silently
 * empty session is worse than a loud one.
 */
async function readSessionMeta(sessionId: string): Promise<SessionMeta> {
  assertSessionId(sessionId);
  const metaPath = path.join(getSessionDir(sessionId), 'meta.json');

  let raw: string;
  try {
    raw = await readFile(metaPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Session not found: ${sessionId} (${metaPath} does not exist)`);
    }
    throw new Error(`Cannot read session ${sessionId}: ${message(error)}`);
  }

  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Corrupted session ${sessionId}: ${metaPath} cannot be parsed — ${message(error)}`,
    );
  }

  if (!isValidSessionMeta(meta)) {
    throw new Error(`Corrupted session ${sessionId}: ${metaPath} has no valid session metadata`);
  }

  return meta;
}

/**
 * Resolve a session id or a unique prefix of one to the full session id.
 *
 * `10x-chat session 3f2a` shows the session whose id starts with `3f2a`.
 */
async function resolveSessionId(idOrPrefix: string): Promise<string> {
  assertSessionId(idOrPrefix);

  const direct = path.join(getSessionDir(idOrPrefix), 'meta.json');
  if (await fileExists(direct)) return idOrPrefix;

  let entries: string[];
  try {
    entries = await readdir(getSessionsDir());
  } catch {
    entries = [];
  }

  const matches = entries.filter((entry) => entry.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`Session not found: ${idOrPrefix}`);
  }
  throw new Error(
    `Session id "${idOrPrefix}" is ambiguous — it matches ${matches.length} sessions ` +
      `(${matches.slice(0, 5).join(', ')}${matches.length > 5 ? ', …' : ''})`,
  );
}

/** Create a new session and return its metadata. */
export async function createSession(
  provider: ProviderName,
  promptPreview: string,
  model?: string,
  backend?: string,
): Promise<SessionMeta> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    provider,
    ...(backend ? { backend } : {}),
    model,
    promptPreview: promptPreview.slice(0, 200),
    createdAt: now,
    updatedAt: now,
    status: 'pending',
  };

  const dir = getSessionDir(id);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/** Update session status and optional duration. */
export async function updateSession(
  sessionId: string,
  update: Partial<Pick<SessionMeta, 'status' | 'durationMs' | 'model'>>,
): Promise<SessionMeta> {
  const meta = await readSessionMeta(sessionId);

  const updated = { ...meta, ...update, updatedAt: new Date().toISOString() };
  await writeFileAtomic(
    path.join(getSessionDir(sessionId), 'meta.json'),
    JSON.stringify(updated, null, 2),
  );
  return updated;
}

/** Save the prompt bundle to the session directory. */
export async function saveBundle(sessionId: string, bundle: string): Promise<string> {
  const filePath = path.join(getSessionDir(sessionId), 'bundle.md');
  await writeFile(filePath, bundle, 'utf-8');
  return filePath;
}

/** Save the assistant response to the session directory. */
export async function saveResponse(sessionId: string, response: string): Promise<string> {
  const filePath = path.join(getSessionDir(sessionId), 'response.md');
  await writeFile(filePath, response, 'utf-8');
  return filePath;
}

/**
 * List recent sessions, sorted by creation time (newest first).
 *
 * A session with broken metadata is skipped — one damaged session must not
 * hide all the others. `getSession` reports the damage of a single session.
 */
export async function listSessions(opts: { hours?: number } = {}): Promise<SessionMeta[]> {
  const { hours = 24 } = opts;
  const sessionsDir = getSessionsDir();

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    try {
      const meta = await readSessionMeta(entry);
      if (new Date(meta.createdAt).getTime() >= cutoff) {
        sessions.push(meta);
      }
    } catch {
      // Skip malformed sessions
    }
  }

  return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Get a single session's full result (meta + file paths). */
export async function getSession(sessionId: string): Promise<SessionResult> {
  const id = await resolveSessionId(sessionId);
  const dir = getSessionDir(id);
  const meta = await readSessionMeta(id);

  const bundlePath = path.join(dir, 'bundle.md');
  const responsePath = path.join(dir, 'response.md');

  const hasResponse = await fileExists(responsePath);

  return {
    meta,
    bundlePath,
    responsePath: hasResponse ? responsePath : undefined,
  };
}
