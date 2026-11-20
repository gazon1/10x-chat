import { createHash } from 'node:crypto';
import type {
  Decision,
  DecisionKind,
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

/** The result of parsing the decisions of an answer. */
export interface ParsedDecisions {
  /** The decisions that passed the schema. */
  decisions: Decision[];
  /** The entries that did not pass it, and why. */
  invalid: string[];
}

/** The kinds of decision the report format knows. */
export const DECISION_KINDS: readonly DecisionKind[] = [
  'Confirmed behavioral change',
  'Intended decision',
  'Implicit decision',
  'Unverified assumption',
];

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
 * How many broken delimiters of an answer are tolerated.
 *
 * The delimiters of a payload that was read are its own — only the ones that
 * carry no JSON at all are counted, and they are the ones of the prose.
 */
const MAX_JSON_CANDIDATES = 50;

/**
 * The JSON payloads of an answer.
 *
 * `exhausted` says that the bound of the candidates was reached: the payload
 * of the answer may lie behind the delimiters that were not tried, and the
 * answer is then not read as "no findings" but as a failure.
 */
export interface JsonCandidates {
  /** The payloads that were found, in the order they appear. */
  candidates: JsonCandidate[];
  /** The bound of the candidates was reached. */
  exhausted: boolean;
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

/** A JSON payload of an answer, with the place it was found. */
export interface JsonCandidate {
  /** The value of the payload. */
  value: unknown;
  /** The payload sat in a fenced block — a model fences its payload. */
  fenced: boolean;
  /** Where the payload starts in the answer. */
  at: number;
}

/** A fenced block of an answer. */
interface Fence {
  /** The content of the block — without the delimiters and the info string. */
  text: string;
  /** The offset of the opening fence in the answer. */
  at: number;
  /** The offset after the closing fence in the answer. */
  end: number;
}

/**
 * The fenced blocks of an answer.
 *
 * A fence of Markdown is three backticks or more, and it is closed by a run
 * of backticks that is at least as long as the opening one — a block of four
 * backticks may hold a fence of three. The info string of the opening fence
 * names the language of the block (`json` in any case) and is not a part of
 * its content. A block that is never closed is not a block: its text stays in
 * the plain text of the answer.
 */
function fencesOf(text: string): Fence[] {
  const fences: Fence[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('```', index);
    if (open < 0) break;
    let opening = 0;
    while (text[open + opening] === '`') opening += 1;
    // The content starts after the info string: the name of the language is
    // not a part of the payload.
    let start = open + opening;
    while (text[start] === ' ' || text[start] === '\t') start += 1;
    const tag = /[A-Za-z][A-Za-z0-9_+.-]*/y;
    tag.lastIndex = start;
    let contentStart = start + (tag.exec(text)?.[0].length ?? 0);
    while (text[contentStart] === ' ' || text[contentStart] === '\t') contentStart += 1;
    const close = closingFence(text, contentStart, opening, lineStart(text, open));
    if (!close) break;
    // A block that holds nothing but its info string is the info string
    // itself — a payload of `true` is a payload, not a language.
    const content = text.slice(contentStart, close.start);
    fences.push({
      text: content.trim() === '' ? text.slice(start, close.start) : content,
      at: open,
      end: close.end,
    });
    index = close.end;
  }
  return fences;
}

/**
 * The run of backticks that closes a fence, if the answer carries one.
 *
 * A fence of Markdown is closed by a run that stands on a line of its own:
 * only whitespace may follow it, and nothing but whitespace may come
 * before it. The fence of a payload that a model wrote in its sentence is
 * the one exception — it is closed on the line of its opening.
 */
function closingFence(
  text: string,
  from: number,
  opening: number,
  openLine: number,
): { start: number; end: number } | undefined {
  let index = from;
  while (index < text.length) {
    const at = text.indexOf('`', index);
    if (at < 0) return undefined;
    let run = 0;
    while (text[at + run] === '`') run += 1;
    if (run >= opening && closesTheLine(text, at, at + run, openLine)) {
      return { start: at, end: at + run };
    }
    index = at + run;
  }
  return undefined;
}

/** Whether a run of backticks stands where the fence of Markdown may end. */
function closesTheLine(text: string, start: number, end: number, openLine: number): boolean {
  const line = lineStart(text, start);
  // Nothing but whitespace after the run on its line.
  const rest = text.slice(end);
  const newline = rest.indexOf('\n');
  const tail = newline < 0 ? rest : rest.slice(0, newline);
  if (tail.trim() !== '') return false;
  // Nothing but whitespace before it — or the fence is closed on the line of
  // its opening, which is the fence of a payload in a sentence.
  if (text.slice(line, start).trim() === '') return true;
  return line === openLine;
}

/** The offset of the start of the line the offset is on. */
function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

/**
 * Every JSON payload of an answer, in the order they appear.
 *
 * A model wraps its JSON in a fence, in a sentence, or in both — and a
 * sentence may carry brackets of its own before the payload. Every balanced
 * object and array of the answer is therefore read. A fence is read on its
 * own and is blanked out of the plain text, so that the delimiters of a
 * payload are counted once.
 */
export function jsonCandidates(text: string): JsonCandidates {
  const fences = fencesOf(text);
  const sources: { text: string; fenced: boolean; at: number }[] = fences.map((fence) => ({
    text: fence.text,
    fenced: true,
    at: fence.at,
  }));
  // The plain text of the answer carries the fences as well: they are blanked
  // out, so that the delimiters of a fenced payload are not counted twice.
  // The offsets of a match are the offsets of the code units of the string:
  // the copy is split the same way, or a character outside the Basic
  // Multilingual Plane before a fence blanks the wrong places.
  const plain = text.split('');
  for (const fence of fences) {
    for (let index = fence.at; index < fence.end; index += 1) plain[index] = ' ';
  }
  sources.push({ text: plain.join(''), fenced: false, at: 0 });

  const candidates: JsonCandidate[] = [];
  const seen = new Set<string>();
  let exhausted = false;
  for (const source of sources) {
    // The end of the last payload that was read: the delimiters inside it are
    // the ones of the payload, not the ones of the prose.
    let covered = 0;
    let broken = 0;
    for (let index = 0; index < source.text.length; index += 1) {
      const character = source.text[index];
      if (character !== '{' && character !== '[') continue;
      const inside = index < covered;
      const slice = balancedSlice(source.text, index);
      if (!slice) {
        if (inside) continue;
        broken += 1;
        if (broken > MAX_JSON_CANDIDATES) {
          // The payload of the answer may lie behind this delimiter: the
          // answer is not read as "no findings" but as a failure.
          exhausted = true;
          break;
        }
        continue;
      }
      try {
        const value: unknown = JSON.parse(slice);
        const key = JSON.stringify(value);
        covered = Math.max(covered, index + slice.length);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ value, fenced: source.fenced, at: source.at + index });
      } catch {
        if (inside) continue;
        broken += 1;
        if (broken > MAX_JSON_CANDIDATES) {
          exhausted = true;
          break;
        }
      }
    }
  }
  return { candidates, exhausted };
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
  const parsed = jsonCandidates(text).candidates.map((candidate) => candidate.value);
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

/** One payload of an answer, with what was read out of it. */
interface CandidateChoice<T extends { invalid: string[] }> {
  candidate: JsonCandidate;
  parsed: T;
  /** The entries of the payload. */
  count: number;
  /** The payload carries its entries under a key — the format of the answer. */
  keyed: boolean;
}

/**
 * The better of two candidates.
 *
 * The payload that carries more of the answer wins: an empty payload is an
 * example of the format and must not hide a payload that carries something —
 * not even a payload whose entries are malformed, because a malformed answer
 * is a failed step, not an empty review. A later payload beats an earlier one
 * — a model that repeats the format of the answer puts the format first, and
 * the answer that follows is the one that counts. The schema of an entry does
 * not decide: a payload whose entries pass the schema is not the answer when
 * a later payload carries the answer itself, and the malformed entries of
 * that payload fail the step instead of being silently dropped. A fenced
 * payload beats an unfenced one, and the payload under a key wins the last tie
 * only: it is the format of the answer, and a bare list is its fallback —
 * never a way to hide a payload that carries the findings.
 */
function betterCandidate<T extends { invalid: string[] }>(
  a: CandidateChoice<T>,
  b: CandidateChoice<T>,
): CandidateChoice<T> {
  // The payload that carries more is the answer: a payload whose entries are
  // malformed must not hide behind a smaller one, or the defect it carries
  // disappears from the review without a word.
  if (a.count !== b.count) return a.count > b.count ? a : b;
  // The answer comes last: the example of the format precedes it.
  if (a.candidate.at !== b.candidate.at) return a.candidate.at > b.candidate.at ? a : b;
  if (a.candidate.fenced !== b.candidate.fenced) {
    return a.candidate.fenced ? a : b;
  }
  return a.keyed ? a : b;
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

/**
 * The entries of a payload.
 *
 * A payload that carries the key of the format is read under that key; a bare
 * list is read as it is. A payload of another shape is no payload of entries.
 */
function payloadEntries(
  payload: unknown,
  key: string,
): { entries: unknown[]; keyed: boolean } | undefined {
  const keyed = keyedEntries(payload, key);
  if (keyed !== undefined) return { entries: keyed, keyed: true };
  if (Array.isArray(payload)) return { entries: payload, keyed: false };
  return undefined;
}

/**
 * The keys of a decision that no finding carries — an entry that carries one
 * of them and no key of a finding is a decision, not a finding.
 *
 * The evidence is in both: a decision cites its evidence as a string, a
 * finding as a list.
 */
const DECISION_KEYS = ['kind', 'decision', 'previous', 'consequence', 'confirmation'];

/**
 * The keys of a finding that no decision carries.
 */
const FINDING_KEYS = [
  'title',
  'severity',
  'category',
  'problem',
  'impact',
  'fix',
  'file',
  'line',
  'endLine',
];

/**
 * Whether an entry looks like a decision.
 *
 * The answer of the architecture pass carries the decisions under their own
 * key, and the array of them is a JSON value of its own: a bare list of
 * decisions must not be read as a bare list of findings.
 */
function looksLikeDecision(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  if (FINDING_KEYS.some((key) => key in value)) return false;
  return DECISION_KEYS.some((key) => key in value);
}

/**
 * The payloads of an answer that may carry entries.
 *
 * The payloads of both shapes are read into one pool: a payload that carries
 * the key must not hide a bare list that carries the findings — the answer
 * would then be read as an empty review. A bare list is a list of entries only
 * when it carries objects that are not payloads themselves: a list of strings
 * is a list of the prose, and a list of payloads is a container of payloads.
 */
function payloadChoices<T extends { invalid: string[] }>(
  candidates: JsonCandidate[],
  key: string,
  parse: (entries: unknown[]) => T,
): CandidateChoice<T>[] {
  const choices: CandidateChoice<T>[] = [];
  for (const candidate of candidates) {
    const payload = payloadEntries(candidate.value, key);
    if (!payload) continue;
    const carriesEntries = payload.entries.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        !(key in (entry as Record<string, unknown>)) &&
        !looksLikeDecision(entry),
    );
    if (!payload.keyed && !carriesEntries) {
      // An empty list is an answer that carries no findings: the prompt asks
      // for it, and a missing payload is not the same thing. A list that
      // carries entries of the wrong shape is no answer, and it stays out.
      if (payload.entries.length > 0) continue;
    }
    const parsed = parse(payload.entries);
    choices.push({
      candidate,
      parsed,
      count: payload.entries.length,
      keyed: payload.keyed,
    });
  }
  return choices;
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
 *
 * A title of stopwords alone carries no word: it normalizes to nothing, and
 * two such findings of one place would share one id. The raw title keeps them
 * apart.
 *
 * The parts of the key are encoded, not joined: a name of a file may hold a
 * colon, and a key that joins the parts with a colon reads the name of one
 * file as the name of another — two findings of two places would share one
 * id, and the verdict of the verifier of one would settle the other.
 */
export function findingId(finding: { file?: string; line?: number; title: string }): string {
  const title = normalizeTitle(finding.title) || finding.title.trim().toLowerCase();
  const key = JSON.stringify([finding.file ?? '', finding.line ?? '', title]);
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
      // The letters and the numbers of every alphabet: a title written in
      // another script carries its meaning too, and an empty title would give
      // the same id to two different findings.
      .split(/[^\p{L}\p{N}]+/u)
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
 * prose of the answer is one of them. The payload that carries the answer is
 * the one that is read — the example of a finding does not carry it, and a
 * malformed answer fails the step instead of being hidden by an example that
 * happens to pass the schema. The payloads of both shapes are read into one
 * pool: a payload under the key of the format must not hide a bare list that
 * carries the findings.
 */
export function parseReviewerFindings(text: string, role: ReviewRole): ParsedFindings {
  const { candidates, exhausted } = jsonCandidates(text);
  // The bound of the candidates was reached: the payload of the answer may be
  // behind the delimiters that were not tried. The answer is then no answer,
  // not an answer without findings.
  const notes = exhausted
    ? [
        `the answer carries more than ${MAX_JSON_CANDIDATES} delimiters without JSON — the payload may be missed`,
      ]
    : [];
  // A findings field that is there and is not a list of findings is a
  // malformed answer: it must not pass as an answer without findings, not
  // even behind an empty payload of another shape.
  const carriesTheFormat = candidates.some(
    (candidate) => keyedEntries(candidate.value, 'findings') !== undefined,
  );
  if (
    !carriesTheFormat &&
    candidates.some((candidate) => carriesMalformedFindings(candidate.value))
  ) {
    return {
      findings: [],
      invalid: ['the answer carries a findings field that is not a list of findings', ...notes],
    };
  }
  // The decisions are the answer of the architecture pass. An answer of another
  // pass that carries them and no findings is an answer to the wrong question:
  // the empty list of the decisions must not pass as an empty list of findings.
  if (
    role !== 'architecture' &&
    candidates.some((candidate) => answersTheDecisionQuestion(candidate.value))
  ) {
    return {
      findings: [],
      invalid: ['the answer carries the decisions of the change and no findings', ...notes],
    };
  }
  const choices = payloadChoices(candidates, 'findings', (entries) =>
    parseFindingEntries(entries, role),
  );
  if (choices.length === 0) {
    // The architecture pass answers two questions: the findings and the
    // decisions. An answer that carries the decisions and no findings has
    // answered one of them: the key of the findings is missing, and a missing
    // key is not an empty list. The findings of that pass would be lost, and
    // the review would approve the change without them.
    if (
      role === 'architecture' &&
      candidates.some((candidate) => keyedEntries(candidate.value, 'decisions') !== undefined)
    ) {
      return {
        findings: [],
        invalid: [
          'the answer carries the decisions of the change and no findings key — the architecture pass answers two questions and must carry both keys',
          ...notes,
        ],
      };
    }
    return {
      findings: [],
      invalid: ['the answer contains no JSON payload of findings', ...notes],
    };
  }
  const best = choices.reduce(betterCandidate);
  return { findings: best.parsed.findings, invalid: [...best.parsed.invalid, ...notes] };
}

/**
 * Whether a payload carries a findings field that is not a list of findings.
 *
 * The field of the format is there and it does not hold what it must hold: the
 * answer is malformed, and it must not pass as an answer without findings.
 */
function carriesMalformedFindings(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!('findings' in record)) return false;
  return !Array.isArray(record.findings);
}

/**
 * Whether a payload carries the decisions of the change and no findings.
 *
 * The answer of the architecture pass carries both keys. An answer of another
 * pass that carries the decisions answers a question it was not asked: the
 * empty list of the decisions must not pass as an empty list of findings.
 */
function answersTheDecisionQuestion(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!('decisions' in record)) return false;
  return !('findings' in record);
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
 * Parse the decisions of an answer.
 *
 * A decision lives under its own key: the payload that carries the findings
 * is the payload of the answer, and the decisions are read out of it. Only a
 * payload that carries the key counts — a bare list of findings is not a list
 * of decisions.
 *
 * An answer without the key has not run the audit: the architecture pass must
 * answer the question, and an empty list of decisions is the answer that says
 * there is none — not the answer that omits it.
 */
export function parseReviewerDecisions(text: string): ParsedDecisions {
  const { candidates, exhausted } = jsonCandidates(text);
  const notes = exhausted
    ? [
        `the answer carries more than ${MAX_JSON_CANDIDATES} delimiters without JSON — the payload may be missed`,
      ]
    : [];
  const choices: CandidateChoice<ParsedDecisions>[] = [];
  for (const candidate of candidates) {
    const entries = keyedEntries(candidate.value, 'decisions');
    if (entries === undefined) continue;
    const parsed = parseDecisionEntries(entries);
    choices.push({ candidate, parsed, count: entries.length, keyed: true });
  }
  if (choices.length === 0) {
    return {
      decisions: [],
      invalid: [
        'the answer carries no decisions — the audit of the implicit decisions did not run',
      ],
    };
  }
  const best = choices.reduce(laterCandidate);
  return { decisions: best.parsed.decisions, invalid: [...best.parsed.invalid, ...notes] };
}

/**
 * The later of two candidates.
 *
 * The answer comes last: a model that repeats the format of the answer puts
 * the format first, and the answer that follows is the one that counts. A
 * decision that the model did not make is not a decision of the change: an
 * earlier payload of one decision must not hide an empty list that says there
 * is none. The count of the entries does not decide here — the payload of the
 * findings needs it, because a malformed answer must not hide behind a
 * smaller one, and the decisions of the change are not defects.
 */
function laterCandidate<T extends { invalid: string[] }>(
  a: CandidateChoice<T>,
  b: CandidateChoice<T>,
): CandidateChoice<T> {
  if (a.candidate.at !== b.candidate.at) return a.candidate.at > b.candidate.at ? a : b;
  if (a.count !== b.count) return a.count > b.count ? a : b;
  return a.candidate.fenced ? a : b;
}

/** The decisions of one payload of an answer. */
function parseDecisionEntries(entries: unknown[]): ParsedDecisions {
  const decisions: Decision[] = [];
  const invalid: string[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid.push(`decisions[${index}]: the entry is not an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const kind = decisionKindOf(value.kind);
    const decision = textOf(value.decision);
    const previous = textOf(value.previous);
    const evidence = evidenceOfDecision(value.evidence);
    const consequence = textOf(value.consequence);
    const risk = textOf(value.risk);
    const confirmation = confirmationOf(value.confirmation);
    // The seven columns of the row of the report: a decision that does not
    // carry all of them is not a decision the report can show. A placeholder
    // in place of the evidence would present an unfinished audit as a
    // finished one.
    const missing = [
      kind === undefined ? 'kind' : undefined,
      decision === undefined ? 'decision' : undefined,
      previous === undefined ? 'previous' : undefined,
      evidence === undefined ? 'evidence' : undefined,
      consequence === undefined ? 'consequence' : undefined,
      risk === undefined ? 'risk' : undefined,
      confirmation === undefined ? 'confirmation' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      invalid.push(`decisions[${index}]: ${missing.join(', ')} missing or malformed`);
      return;
    }
    decisions.push({
      kind: kind as DecisionKind,
      decision: decision as string,
      previous: previous as string,
      evidence: evidence as string,
      consequence: consequence as string,
      risk: risk as string,
      confirmation: confirmation as 'yes' | 'no',
    });
  });

  return { decisions, invalid };
}

/** The kind of a decision — the kinds of the report format, and nothing else. */
function decisionKindOf(value: unknown): DecisionKind | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  const found = DECISION_KINDS.find((kind) => kind.toLowerCase() === text.toLowerCase());
  return found;
}

/**
 * The evidence of a decision — a string or a list of them.
 *
 * A decision cites its evidence as a string; a model that writes a list of
 * references is read as one string.
 */
function evidenceOfDecision(value: unknown): string | undefined {
  if (typeof value === 'string') return textOf(value);
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .map((item) => textOf(item))
    .filter((item): item is string => item !== undefined);
  return texts.length === 0 ? undefined : texts.join('; ');
}

/** Whether a human has to confirm a decision. */
function confirmationOf(value: unknown): 'yes' | 'no' | undefined {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = textOf(value)?.toLowerCase();
  if (text === 'yes' || text === 'no') return text;
  return undefined;
}

/**
 * Parse the answer of a verification pass.
 *
 * A verdict without an id belongs to no finding, and a verdict without a
 * state is no verdict: both are invalid.
 *
 * An answer may carry more than one payload: the payload that carries the
 * answer is the one that is read.
 */
export function parseVerdicts(text: string): ParsedVerdicts {
  const { candidates, exhausted } = jsonCandidates(text);
  const notes = exhausted
    ? [
        `the answer carries more than ${MAX_JSON_CANDIDATES} delimiters without JSON — the payload may be missed`,
      ]
    : [];
  const choices = payloadChoices(candidates, 'verdicts', (entries) => parseVerdictEntries(entries));
  if (choices.length === 0) {
    return {
      verdicts: [],
      invalid: ['the answer contains no JSON payload of verdicts', ...notes],
    };
  }
  const best = choices.reduce(betterCandidate);
  return { verdicts: best.parsed.verdicts, invalid: [...best.parsed.invalid, ...notes] };
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
  // Every title that was merged into a finding is kept: the overlap of the
  // titles is not transitive, so a finding that overlaps a merged title is the
  // same defect even when it does not overlap the title that was kept.
  const merged: { finding: Finding; titles: string[] }[] = [];
  for (const finding of findings) {
    const twin = merged.find(
      (entry) =>
        entry.finding.file === finding.file &&
        entry.finding.line === finding.line &&
        entry.titles.some((title) => overlap(title, finding.title) >= 0.6),
    );
    if (!twin) {
      merged.push({ finding: { ...finding }, titles: [finding.title] });
      continue;
    }
    const other = twin.finding;
    other.severity = worstSeverity(other.severity, finding.severity);
    other.evidence = [...new Set([...other.evidence, ...finding.evidence])];
    other.reportedBy = [...new Set([...other.reportedBy, ...finding.reportedBy])];
    other.verification = strongestState(other.verification, finding.verification);
    if (!other.verificationNote && finding.verificationNote) {
      other.verificationNote = finding.verificationNote;
    }
    if (!other.fix && finding.fix) other.fix = finding.fix;
    twin.titles.push(finding.title);
  }
  return merged.map((entry) => entry.finding);
}
