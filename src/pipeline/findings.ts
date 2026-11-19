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

/** How many opening delimiters of an answer are tried. */
const MAX_JSON_CANDIDATES = 50;

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

/** A JSON payload of an answer, with the place it was found. */
export interface JsonCandidate {
  /** The value of the payload. */
  value: unknown;
  /** The payload sat in a fenced block — a model fences its payload. */
  fenced: boolean;
  /** Where the payload starts in the answer. */
  at: number;
}

/**
 * Every JSON payload of an answer, in the order they appear.
 *
 * A model wraps its JSON in a fence, in a sentence, or in both — and a
 * sentence may carry brackets of its own before the payload. Every balanced
 * object and array of the answer is therefore read. The same payload is
 * seen twice when it sits in a fence, so the copies are told apart by their
 * text.
 */
export function jsonCandidates(text: string): JsonCandidate[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const sources: { text: string; fenced: boolean; at: number }[] = fences.map((match) => ({
    text: match[1],
    fenced: true,
    at: match.index ?? 0,
  }));
  sources.push({ text, fenced: false, at: 0 });

  const candidates: JsonCandidate[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    let tried = 0;
    for (let index = 0; index < source.text.length && tried < MAX_JSON_CANDIDATES; index += 1) {
      const character = source.text[index];
      if (character !== '{' && character !== '[') continue;
      tried += 1;
      const slice = balancedSlice(source.text, index);
      if (!slice) continue;
      try {
        const value: unknown = JSON.parse(slice);
        const key = JSON.stringify(value);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ value, fenced: source.fenced, at: source.at + index });
      } catch {
        // Not the payload — the next opening delimiter may be.
      }
    }
  }
  return candidates;
}

/**
 * The JSON of an answer.
 *
 * The payload that carries the wanted key wins; the biggest array is the
 * fallback for an answer that is a bare list.
 *
 * shortcut: an example of the schema in the prose can carry the key too, and
 * this function cannot tell an example from the payload — the parsers of the
 * findings and of the verdicts do tell them apart, by their schema.
 */
export function extractJson(text: string, key?: string): unknown {
  const parsed = jsonCandidates(text).map((candidate) => candidate.value);
  if (key !== undefined) {
    const withKey = parsed.filter(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value) && key in value,
    );
    if (withKey.length > 0) {
      return withKey.reduce((biggest, value) =>
        (entriesOf(value, key)?.length ?? 0) > (entriesOf(biggest, key)?.length ?? 0)
          ? value
          : biggest,
      );
    }
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

/**
 * The better of two candidates.
 *
 * The payload that lost the least wins: the entries that pass the schema are
 * the answer, the example of the schema is not. A fenced payload beats an
 * unfenced one, a payload with more entries beats one with less, and a later
 * payload beats an earlier one — a model that repeats the format of the
 * answer puts the format first.
 */
function betterCandidate<T extends { invalid: string[] }>(
  a: { candidate: JsonCandidate; parsed: T; count: number },
  b: { candidate: JsonCandidate; parsed: T; count: number },
): { candidate: JsonCandidate; parsed: T; count: number } {
  if (a.parsed.invalid.length !== b.parsed.invalid.length) {
    return a.parsed.invalid.length < b.parsed.invalid.length ? a : b;
  }
  if (a.candidate.fenced !== b.candidate.fenced) {
    return a.candidate.fenced ? a : b;
  }
  if (a.count !== b.count) {
    return a.count > b.count ? a : b;
  }
  return a.candidate.at >= b.candidate.at ? a : b;
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

/**
 * The entries under a key of a payload.
 *
 * A bare array is no payload of a key: an answer that carries a list of
 * strings somewhere in it would otherwise be read as a list of findings.
 */
function keyedEntries(payload: unknown, key: string): unknown[] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const entries = (payload as Record<string, unknown>)[key];
  return Array.isArray(entries) ? entries : undefined;
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
 *
 * An answer may carry more than one payload: an example of the schema in the
 * prose of the answer is one of them. The payload whose entries pass the
 * schema wins — an example of a finding does not.
 */
export function parseReviewerFindings(text: string, role: ReviewRole): ParsedFindings {
  const keyed = jsonCandidates(text)
    .filter((candidate) => keyedEntries(candidate.value, 'findings') !== undefined)
    .map((candidate) => {
      const entries = keyedEntries(candidate.value, 'findings') ?? [];
      return {
        candidate,
        parsed: parseFindingEntries(entries, role),
        count: entries.length,
      };
    });
  if (keyed.length > 0) {
    const best = keyed.reduce(betterCandidate);
    return { findings: best.parsed.findings, invalid: best.parsed.invalid };
  }

  // An answer that is a bare list of findings.
  const bare = jsonCandidates(text)
    .filter((candidate) => Array.isArray(candidate.value))
    .map((candidate) => {
      const entries = candidate.value as unknown[];
      return {
        candidate,
        parsed: parseFindingEntries(entries, role),
        count: entries.length,
      };
    });
  if (bare.length === 0) {
    return { findings: [], invalid: ['the answer contains no JSON payload of findings'] };
  }
  const best = bare.reduce(betterCandidate);
  return { findings: best.parsed.findings, invalid: best.parsed.invalid };
}

/** The findings of one payload of an answer. */
function parseFindingEntries(entries: unknown[], role: ReviewRole): ParsedFindings {
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
 *
 * An answer may carry more than one payload: the payload whose entries pass
 * the schema wins.
 */
export function parseVerdicts(text: string): ParsedVerdicts {
  const keyed = jsonCandidates(text)
    .filter((candidate) => keyedEntries(candidate.value, 'verdicts') !== undefined)
    .map((candidate) => {
      const entries = keyedEntries(candidate.value, 'verdicts') ?? [];
      return { candidate, parsed: parseVerdictEntries(entries), count: entries.length };
    });
  if (keyed.length > 0) {
    const best = keyed.reduce(betterCandidate);
    return { verdicts: best.parsed.verdicts, invalid: best.parsed.invalid };
  }

  // An answer that is a bare list of verdicts.
  const bare = jsonCandidates(text)
    .filter((candidate) => Array.isArray(candidate.value))
    .map((candidate) => {
      const entries = candidate.value as unknown[];
      return { candidate, parsed: parseVerdictEntries(entries), count: entries.length };
    });
  if (bare.length === 0) {
    return { verdicts: [], invalid: ['the answer contains no JSON payload of verdicts'] };
  }
  const best = bare.reduce(betterCandidate);
  return { verdicts: best.parsed.verdicts, invalid: best.parsed.invalid };
}

/** The verdicts of one payload of an answer. */
function parseVerdictEntries(entries: unknown[]): ParsedVerdicts {
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
