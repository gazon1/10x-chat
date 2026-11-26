/**
 * The committed report is public: it must not carry the layout of the machine
 * it was produced on.
 *
 * Three kinds of data are replaced:
 *   - absolute paths of the machine (the repository becomes relative, the home
 *     directory keeps only its tail — the convention of `spike/readiness` — and a
 *     path of any other filesystem becomes `<path>`),
 *   - the ids of the MCode sessions (a session id addresses a stored
 *     conversation, so a published one would hand out that conversation),
 *   - the BYOK provider of the machine — its id and, inside a model value, the
 *     name of its account.
 *
 * The replacements are stable (the same value always becomes the same
 * placeholder), so two ids that differ in the report still differ after the
 * sanitizing — the evidence of the spike survives.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The repository root: spike/acp/ lives two levels below it.
const REPO_ROOT = resolve(HERE, '..', '..');

const SESSION_ID = /\bmvs_[0-9a-f]{32}\b/g;
const PROVIDER_ID = /\bprovider-[0-9a-f]{6,}\b/g;
// the name of the BYOK account of the machine, inside a model value and inside
// the metadata of a turn. The account name may itself be percent encoded, so
// the segment ends at the next raw colon — a colon of the name is encoded.
const PROVIDER_SEGMENT = /custom_provider%3A[^:]+/g;
const PROVIDER_NAME = /custom_provider:[^:]+/g;
// an absolute path that is in no known root is machine data as well
const ABSOLUTE_PATH = /(^|[\s"'`(=])(\/[^\s"'`),;]*)/g;

/** A stable, anonymous placeholder for a session id. */
export function publicSessionId(value) {
  if (typeof value !== 'string' || !value) return value === undefined ? null : value;
  if (!/^mvs_[0-9a-f]{32}$/.test(value)) return value;
  return `mvs_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** Replaces the machine data inside a text (paths, session ids, provider ids). */
export function publicText(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  // the repository first: it lives inside the home directory
  if (REPO_ROOT) out = out.split(REPO_ROOT).join('<repo>');
  const home = homedir();
  if (home) out = out.split(home).join('~');
  out = out.replace(SESSION_ID, (id) => publicSessionId(id));
  out = out.replace(PROVIDER_ID, 'provider-<id>');
  out = out.replace(PROVIDER_SEGMENT, 'custom_provider%3A<provider>');
  out = out.replace(PROVIDER_NAME, 'custom_provider:<provider>');
  // a path of another filesystem would tell the layout of the machine
  out = out.replace(ABSOLUTE_PATH, (_match, before) => `${before}<path>`);
  return out;
}

/** Walks a report and replaces every machine specific value it holds. */
export function sanitizeReport(value) {
  if (typeof value === 'string') return publicText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeReport(entry));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeReport(entry);
    }
    return out;
  }
  return value;
}
