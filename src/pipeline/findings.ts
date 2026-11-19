import { createHash } from 'node:crypto';
import type {
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingVerification,
  ReviewRole,
} from './types.js';

/** The severities of the report format, from the most to the least grave. */
export const SEVERITIES: readonly FindingSeverity[] = ['BLOCKING', 'MAJOR', 'MINOR', 'INFO'];

/** The categories a finding can carry. */
export const CATEGORIES: readonly FindingCategory[] = [
  'correctness',
  'security',
  'architecture',
  'maintainability',
  'tests',
  'compatibility',
  'scope',
  'other',
];

/** The states a verification can produce. */
export const VERIFICATIONS: readonly FindingVerification[] = [
  'unverified',
  'confirmed',
  'rejected',
];

/** The result of parsing the answer of a reviewer. */
export interface ParsedFindings {
  /** The findings that passed the schema. */
  findings: Finding[];
  /** The entries that did not pass it, and why. */
  invalid: string[];
}

/** The verdict of a verification pass for one finding. */
export interface VerificationVerdict {
  /** The id of the finding the verdict belongs to. */
  id: string;
  verdict: FindingVerification;
  evidence: string;
  note?: string;
}

/** The result of parsing the answer of a verification pass. */
export interface ParsedVerdicts {
  verdicts: VerificationVerdict[];
  invalid: string[];
}

/**
 * The balanced slice that starts at an opening delimiter.
 *
 * The scan knows the strings: a brace inside a string value does not open a
 * nested object, and an escaped quote does not close a string.
 */
function balancedSlice(text: string, start: number): string | undefined {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * The JSON of an answer.
 *
 * A model wraps its JSON in a fence, in a sentence, or in both — and a
 * sentence may carry brackets of its own before the payload. Every balanced
 * object and array of the answer is therefore read, and the one that carries
 * the wanted key wins; the biggest array is the fallback for an answer that
 * is a bare list.
 */
export function extractJson(text: string, key?: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced?.[1] ? [fenced[1], text] : [text];
  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    for (let index = 0; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (character !== '{' && character !== '[') continue;
      const slice = balancedSlice(candidate, index);
      if (!slice) continue;
      try {
        parsed.push(JSON.parse(slice));
      } catch {
        // Not the payload — the next opening delimiter may be.
      }
    }
  }
  if (key !== undefined) {
    const withKey = parsed.find(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value) && key in value,
    );
    if (withKey !== undefined) return withKey;
  }
  const arrays = parsed.filter((value): value is unknown[] => Array.isArray(value));
  if (arrays.length > 0) {
    return arrays.reduce((biggest, array) => (array.length > biggest.length ? array : biggest));
  }
  const objects = parsed.find(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return objects ?? parsed[0];
}

/** The entries of a payload — an array of them, or the list under a key. */
function entriesOf(payload: unknown, key: string): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const entries = (payload as Record<string, unknown>)[key];
    if (Array.isArray(entries)) return entries;
  }
  return undefined;
}

/** A non-empty string, or undefined. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/**
 * A line number — a number, or a string that holds one.
 *
 * A malformed value is no line: `12garbage` and `12.9` are not a line 12.
 */
function lineOf(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** A value that is there but is not a line number. */
function malformedLine(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return lineOf(value) === undefined;
}

/** The severity of a finding — unknown ones are `INFO`. */
function severityOf(value: unknown): FindingSeverity | undefined {
  const text = textOf(value)?.toUpperCase();
  return SEVERITIES.find((severity) => severity === text);
}

/** The category of a finding — unknown ones are `other`. */
function categoryOf(value: unknown): FindingCategory {
  const text = textOf(value)?.toLowerCase();
  return CATEGORIES.find((category) => category === text) ?? 'other';
}

/** The evidence of a finding — one string or a list of them. */
function evidenceOf(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? [] : [text];
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => textOf(item)).filter((item): item is string => item !== undefined);
}

/**
 * The id of a finding.
 *
 * The id is a hash of the location and of the normalized title: the same
 * defect keeps it between the runs and between the reviewers.
 */
export function findingId(finding: { file?: string; line?: number; title: string }): string {
  const key = `${finding.file ?? ''}:${finding.line ?? ''}:${normalizeTitle(finding.title)}`;
  return `f-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
}

/** The words of a title that carry its meaning. */
function tokensOf(title: string): Set<string> {
  const stopwords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'to',
    'of',
    'in',
    'on',
    'and',
    'or',
    'not',
    'no',
    'with',
    'for',
    'this',
    'that',
    'it',
    'be',
    'can',
    'will',
    'does',
    'do',
    'from',
    'by',
    'at',
    'as',
    'if',
    'then',
    'than',
    'but',
    'has',
    'have',
    'when',
    'into',
    'its',
    'their',
  ]);
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '' && !stopwords.has(word)),
  );
}

/** The comparable form of a title — the words of it, sorted. */
export function normalizeTitle(title: string): string {
  return [...tokensOf(title)].sort().join(' ');
}

/**
 * Parse the answer of a reviewer.
 *
 * A reviewer that answers with prose has answered nothing: the payload is
 * missing and the finding is empty. An entry that does not pass the schema
 * is reported as invalid — it is never silently dropped and never silently
 * promoted.
 */
export function parseReviewerFindings(text: string, role: ReviewRole): ParsedFindings {
  const payload = extractJson(text, 'findings');
  const entries = entriesOf(payload, 'findings');
  if (!entries) {
    return { findings: [], invalid: ['the answer contains no JSON payload of findings'] };
  }

  const findings: Finding[] = [];
  const invalid: string[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push(`findings[${index}]: the entry is not an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const title = textOf(value.title);
    const severity = severityOf(value.severity);
    const problem = textOf(value.problem);
    const impact = textOf(value.impact);
    const missing = [
      title === undefined ? 'title' : undefined,
      severity === undefined ? 'severity' : undefined,
      problem === undefined ? 'problem' : undefined,
      impact === undefined ? 'impact' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (
      missing.length > 0 ||
      title === undefined ||
      problem === undefined ||
      impact === undefined
    ) {
      invalid.push(`findings[${index}]: ${missing.join(', ')} missing or malformed`);
      return;
    }
    const file = textOf(value.file);
    if (malformedLine(value.line) || malformedLine(value.endLine)) {
      invalid.push(`findings[${index}]: line malformed`);
      return;
    }
    const line = lineOf(value.line);
    const endLine = lineOf(value.endLine);
    const fix = textOf(value.fix);
    findings.push({
      id: findingId({ ...(file ? { file } : {}), ...(line ? { line } : {}), title }),
      title,
      severity: severity as FindingSeverity,
      category: categoryOf(value.category),
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(endLine ? { endLine } : {}),
      problem,
      impact,
      evidence: evidenceOf(value.evidence),
      ...(fix ? { fix } : {}),
      // A finding is not confirmed because it parsed: the verification pass
      // is what decides.
      verification: 'unverified',
      reportedBy: [role],
    });
  });

  return { findings, invalid };
}

/**
 * Parse the answer of a verification pass.
 *
 * A verdict without an id belongs to no finding, and a verdict without a
 * state is no verdict: both are invalid.
 */
export function parseVerdicts(text: string): ParsedVerdicts {
  const payload = extractJson(text, 'verdicts');
  const entries = entriesOf(payload, 'verdicts');
  if (!entries) {
    return { verdicts: [], invalid: ['the answer contains no JSON payload of verdicts'] };
  }

  const verdicts: VerificationVerdict[] = [];
  const invalid: string[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push(`verdicts[${index}]: the entry is not an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const id = textOf(value.id);
    const verdict = textOf(value.verdict)?.toLowerCase();
    if (!id) {
      invalid.push(`verdicts[${index}]: id missing`);
      return;
    }
    if (!verdict || !VERIFICATIONS.includes(verdict as FindingVerification)) {
      invalid.push(`verdicts[${index}]: verdict missing or unknown`);
      return;
    }
    const evidence = textOf(value.evidence) ?? '';
    const note = textOf(value.note);
    verdicts.push({
      id,
      verdict: verdict as FindingVerification,
      evidence,
      ...(note ? { note } : {}),
    });
  });

  return { verdicts, invalid };
}

/** The order of the severities — the first one is the most grave. */
const SEVERITY_ORDER: readonly FindingSeverity[] = ['BLOCKING', 'MAJOR', 'MINOR', 'INFO'];

/** The severity of the most grave of two severities. */
function worstSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/**
 * How much two titles overlap — one is the same defect when they overlap.
 *
 * The coverage of the shorter title and the coverage of the longer one both
 * count: a title that is swallowed by a much longer one is a different
 * defect, not the same one written twice.
 *
 * shortcut: two titles that differ by a single word still merge — no token
 * metric separates "reaches shell" from "reaches shell command". Upgrade to a
 * comparison of the claims themselves when a review reports two defects of one
 * place as one.
 */
function overlap(a: string, b: string): number {
  const tokensA = tokensOf(a);
  const tokensB = tokensOf(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  return Math.min(shared / tokensA.size, shared / tokensB.size);
}

/** The state that wins when two states of the same finding disagree. */
function strongestState(a: FindingVerification, b: FindingVerification): FindingVerification {
  if (a === b) return a;
  // A confirmed finding and a rejected one contradict each other: neither
  // can be taken — the finding stays unverified.
  if ((a === 'confirmed' && b === 'rejected') || (a === 'rejected' && b === 'confirmed')) {
    return 'unverified';
  }
  return a === 'confirmed' || b === 'confirmed' ? 'confirmed' : 'unverified';
}

/**
 * Normalize and deduplicate the findings of the reviewers.
 *
 * Two reviewers that describe the same defect at the same place report it
 * once: the most grave severity wins, the evidence of both is kept and the
 * roles that reported it are named.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const merged: Finding[] = [];
  for (const finding of findings) {
    const twin = merged.find(
      (other) =>
        other.file === finding.file &&
        other.line === finding.line &&
        overlap(other.title, finding.title) >= 0.6,
    );
    if (!twin) {
      merged.push({ ...finding });
      continue;
    }
    twin.severity = worstSeverity(twin.severity, finding.severity);
    twin.evidence = [...new Set([...twin.evidence, ...finding.evidence])];
    twin.reportedBy = [...new Set([...twin.reportedBy, ...finding.reportedBy])];
    twin.verification = strongestState(twin.verification, finding.verification);
    if (!twin.verificationNote && finding.verificationNote) {
      twin.verificationNote = finding.verificationNote;
    }
    if (!twin.fix && finding.fix) twin.fix = finding.fix;
  }
  return merged;
}
