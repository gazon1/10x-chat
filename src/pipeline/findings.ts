import { createHash } from 'node:crypto';
import type {
  Decision,
  DecisionKind,
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingVerification,
  ImprovementPriority,
  ReviewImprovement,
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

/**
 * The kinds of an implicit decision.
 *
 * An unknown kind is an implicit one: a decision nobody could classify is a
 * decision that needs the attention of a human.
 */
export const DECISION_KINDS: readonly DecisionKind[] = [
  'behavior_change',
  'intended',
  'implicit',
  'assumption',
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

/** The result of parsing the decisions of an answer. */
export interface ParsedDecisions {
  /** The decisions that passed the schema. */
  decisions: Decision[];
  /** The entries that did not pass it, and why. */
  invalid: string[];
}

/** The result of parsing the answer of the advisory improvement assessment. */
export interface ParsedImprovements {
  recommendations: ReviewImprovement[];
  invalid: string[];
  /** No payload of recommendations was found — the answer was not read. */
  missing: boolean;
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
  /** Where the payload ends in the answer. */
  end: number;
  /** The prose introduces the payload as an example of the format. */
  example: boolean;
}

/** A fenced block of an answer. */
interface Fence {
  /** The content of the block — without the delimiters and the info string. */
  text: string;
  /** The offset of the opening fence in the answer. */
  at: number;
  /** The offset of the content of the block in the answer. */
  contentAt: number;
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
    const empty = content.trim() === '';
    fences.push({
      text: empty ? text.slice(start, close.start) : content,
      at: open,
      // The content of the fence is at its own place in the answer: the
      // payload that is in it is at the place of its content, and the prose
      // around it is the prose of the answer.
      contentAt: empty ? start : contentStart,
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
    at: fence.contentAt,
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
  let exhausted = false;
  for (const source of sources) {
    // The end of the last payload that was read: the delimiters inside it are
    // the ones of the payload, not the ones of the prose.
    let covered = 0;
    let broken = 0;
    for (let index = 0; index < source.text.length; index += 1) {
      const character = source.text[index];
      if (character !== '{' && character !== '[') continue;
      // A payload that is nested in another one is a part of it, not an
      // answer: the answer of a reviewer is the payload of the top level.
      if (index < covered) continue;
      const slice = balancedSlice(source.text, index);
      if (!slice) {
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
        covered = Math.max(covered, index + slice.length);
        // Two payloads that carry the same value are two payloads: the answer
        // comes last, and an example that repeats the answer of the reviewer
        // does not erase it.
        const at = source.at + index;
        candidates.push({
          value,
          fenced: source.fenced,
          at,
          end: at + slice.length,
          example: false,
        });
      } catch {
        broken += 1;
        if (broken > MAX_JSON_CANDIDATES) {
          exhausted = true;
          break;
        }
      }
    }
  }
  // The prose that introduces a payload is the prose between it and the
  // payload before it: the word that says "example" belongs to the sentence
  // that introduces the payload, and not to a word of a payload.
  candidates.sort((a, b) => a.at - b.at);
  let prose = 0;
  for (const candidate of candidates) {
    candidate.example = introducesAsExample(text.slice(prose, candidate.at));
    prose = candidate.end;
  }
  return { candidates, exhausted };
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

/** The words of a text that carry no meaning of their own. */
const STOPWORDS = new Set([
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

/**
 * The negation of a statement — the word that turns it around.
 *
 * A decision and the opposite of a decision are two decisions: "the retry is
 * idempotent" and "the retry is not idempotent" disagree about the contract
 * of the change, and a merge of the two hides the disagreement.
 */
const NEGATIONS = new Set(['not', 'no']);

/**
 * The words of a text.
 *
 * The letters and the numbers of every alphabet: a title written in another
 * script carries its meaning too, and an empty title would give the same id
 * to two different findings.
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** The words of a title that carry its meaning. */
function tokensOf(title: string): Set<string> {
  return new Set(wordsOf(title).filter((word) => !STOPWORDS.has(word)));
}

/** The comparable form of a title — the words of it, sorted. */
export function normalizeTitle(title: string): string {
  return [...tokensOf(title)].sort().join(' ');
}

/**
 * Whether the prose introduces a payload as an example of the format.
 *
 * A model that shows the format of its answer writes a word before the
 * payload — "for example", "a sample answer", "e.g.". Such a payload carries
 * the entries of the example, not the entries the reviewer found, and it must
 * never pass as the answer: the review would report findings that nobody
 * made, and the audit of the decisions would pass on an answer that never
 * answered.
 *
 * The word must introduce the payload that follows it: the marker and the
 * payload belong to the same sentence, and no full stop, exclamation mark or
 * question mark lies between them. A sentence that talks about an example of
 * the problem, and not of the format of the answer, says nothing about the
 * payload that comes after it — "one example of this problem is the missing
 * validation. Here are my actual findings:" introduces the answer, not an
 * example.
 *
 * A preamble that only names the format — "the format I use is" — introduces
 * no example: the payload that follows it may be the answer itself.
 *
 * The prose is the text between the payload and the one before it: a word of
 * a payload says nothing about the payload that follows it.
 */
function introducesAsExample(prose: string): boolean {
  // The abbreviations carry their own full stops: they are masked before the
  // prose is read, so that they do not end a sentence.
  const masked = prose.replace(/\be\.g\./gi, EXAMPLE_EG).replace(/\bi\.e\./gi, EXAMPLE_IE);
  const markers = [...masked.matchAll(EXAMPLE_PATTERN)];
  const last = markers.at(-1);
  if (!last) return false;
  // The full stop that ends the label of the payload is not a sentence of its
  // own: only the punctuation that lies between the marker and the payload
  // tells that another sentence came in between.
  const between = masked.slice(last.index + last[0].length).replace(/[\s.!?]+$/, '');
  return !/[.!?]/.test(between);
}

/** The words that introduce an example of the format of an answer. */
const EXAMPLE_PATTERN = /\b(example|examples|sample)\b|\bexampleabbreviation\b/gi;

/** The abbreviation that introduces an example. */
const EXAMPLE_EG = 'exampleabbreviation';

/** The abbreviation that carries a full stop but introduces no example. */
const EXAMPLE_IE = 'ieabbreviation';

/**
 * The payload of the answer — the last payload of the text.
 *
 * The answer comes last: a model that repeats the format of its answer puts
 * the format first, and the answer that follows is the one that counts. The
 * payload of the answer is found by its position and not by the shape it has:
 * an answer whose findings are malformed is still the answer, and the parser
 * of the findings is the one that has to report it.
 *
 * A payload that the prose introduces as an example is not the answer, and it
 * never passes as one — not even when it is the only payload of the answer:
 * the answer of a reviewer is the payload of the top level, and the example
 * of the format is not it. An answer that carries nothing but an example is
 * no answer at all, and the step of the reviewer fails.
 *
 * An empty bare list is the second exception: it carries nothing, and a list
 * of the prose — an empty pair of brackets in a sentence — says nothing about
 * the review. It is displaced by every other payload of the answer, and it
 * answers only when nothing else does. A payload under the key is never
 * displaced by it, not even when it carries no findings: the prompt asks for
 * that payload, and it is the answer that says there is none.
 */
function answerCandidate(
  candidates: JsonCandidate[],
  carriesShape: (value: unknown) => boolean = carriesTheShapeOfAnAnswer,
): JsonCandidate | undefined {
  const eligible = candidates.filter((candidate) => carriesShape(candidate.value));
  // An example is not an answer. An answer that carries nothing but an
  // example has not answered, and the step of the reviewer fails: an example
  // that passes as the answer would pass the audit of a reviewer that never
  // ran it.
  const base = eligible.filter((candidate) => !candidate.example);
  const pool = base.every((candidate) => isEmptyBareList(candidate.value))
    ? base
    : base.filter((candidate) => !isEmptyBareList(candidate.value));
  let answer: JsonCandidate | undefined;
  for (const candidate of pool) {
    if (!answer || candidate.at > answer.at) answer = candidate;
  }
  return answer;
}

/** Whether a payload is a bare list that carries nothing. */
function isEmptyBareList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** Whether a payload carries the shape of an answer of a reviewer. */
function carriesTheShapeOfAnAnswer(value: unknown): boolean {
  // A bare list is the answer of a reviewer that answered without the key —
  // but only a list of entries: a list of strings is a list of the prose
  // ("the files I looked at"), and a list of payloads is a container of
  // payloads. Neither carries the answer, and neither may replace it.
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => isAnEntryOfTheFindings(entry));
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  // The presence of the key marks the payload of the answer, not its value:
  // an answer whose findings are malformed is still the answer, and the
  // parser of the findings is the one that has to report it.
  return 'findings' in record || 'decisions' in record;
}

/**
 * Whether an entry of a bare list is an entry of the findings.
 *
 * The decisions of an answer travel next to the findings: a bare list of them
 * is a list of decisions, and it must not be read as a list of findings.
 */
function isAnEntryOfTheFindings(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  return !('findings' in value) && !('needsHuman' in value);
}

/** Whether a payload carries the shape of an answer of a verifier. */
function carriesTheShapeOfAVerdictionAnswer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => !!entry && typeof entry === 'object');
  }
  if (!value || typeof value !== 'object') return false;
  // The presence of the key marks the payload of the answer, not its value: a
  // verdicts field that is not a list is a malformed answer, and it must not
  // pass as an answer without verdicts.
  return 'verdicts' in (value as Record<string, unknown>);
}

/**
 * Whether a payload carries the shape of an answer of the decisions.
 *
 * The shape is a list of decisions: a payload that carries the key with a
 * broken list is no answer of the audit — it is a broken payload, and it is
 * reported wherever it is. A reviewer that answered a good list and a broken
 * one are two things, and the good one must not disappear because the broken
 * one came after it.
 */
function carriesTheShapeOfADecisionAnswer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray((value as Record<string, unknown>).decisions);
}

/** The note of a payload that carries the key of the decisions with a broken list. */
function brokenDecisionsOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!('decisions' in record) || Array.isArray(record.decisions)) return undefined;
  return 'decisions: the property is not an array';
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
  // The payload of the answer is the last payload of the answer: the answer
  // comes last, and the number of the entries does not decide. An example of
  // the schema that precedes the answer carries findings that the reviewer did
  // not make, and it must not pass as the answer.
  const answer = answerCandidate(candidates, carriesTheShapeOfAnAnswer);
  if (!answer) {
    return {
      findings: [],
      invalid: ['the answer contains no JSON payload of findings', ...notes],
    };
  }
  // A bare list is the answer of a reviewer that answered without the key.
  if (Array.isArray(answer.value)) {
    const parsed = parseFindingEntries(answer.value, role);
    return { findings: parsed.findings, invalid: [...parsed.invalid, ...notes] };
  }
  const record = answer.value as Record<string, unknown>;
  if (!('findings' in record)) {
    // The answer carries the decisions and no findings: the key of the
    // findings is missing, and a missing key is not an empty list of findings.
    return {
      findings: [],
      invalid: ['the answer contains no JSON payload of findings', ...notes],
    };
  }
  // A findings field that is there and is not a list of findings is a
  // malformed answer: it must not pass as an answer without findings, and it
  // must not fall back to an earlier payload of the answer.
  if (!Array.isArray(record.findings)) {
    return {
      findings: [],
      invalid: ['the answer carries a findings field that is not a list of findings', ...notes],
    };
  }
  const parsed = parseFindingEntries(record.findings, role);
  return { findings: parsed.findings, invalid: [...parsed.invalid, ...notes] };
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
 * The words a reviewer may use for a kind of decision.
 *
 * The kind of a decision is required, like the severity of a finding: a
 * decision that carries an unknown kind is malformed, and the step of the role
 * fails. A reviewer that writes the kind in the words of the report — "an
 * implicit decision" — still says a kind.
 */
const DECISION_KIND_WORDS: Record<string, DecisionKind> = {
  behaviorchange: 'behavior_change',
  intended: 'intended',
  intendeddecision: 'intended',
  implicit: 'implicit',
  implicitdecision: 'implicit',
  assumption: 'assumption',
  unverifiedassumption: 'assumption',
};

/**
 * The kind of a decision — an unknown kind is no kind.
 *
 * The example of the format carries the union of the kinds, and it is not a
 * kind: an answer that echoes the example of the schema fails the step of the
 * role instead of reporting the example as a decision of the change.
 */
function decisionKindOf(value: unknown): DecisionKind | undefined {
  const text = textOf(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return text ? DECISION_KIND_WORDS[text] : undefined;
}

/**
 * The comparable form of a decision — the words of it, in their order.
 *
 * The order matters: "A sends messages to B" and "B sends messages to A"
 * are two different contracts, and a form that sorts the words of them would
 * read them as one. The negation matters too: a decision and its opposite
 * disagree about the contract of the change.
 */
export function normalizeDecision(decision: string): string {
  return wordsOf(decision)
    .filter((word) => !STOPWORDS.has(word) || NEGATIONS.has(word))
    .join(' ');
}

/**
 * The id of a decision.
 *
 * The id is a hash of the normalized text of the decision: two roles that
 * report the same decision report one decision.
 */
export function decisionId(decision: string): string {
  const key = JSON.stringify(normalizeDecision(decision) || decision.trim().toLowerCase());
  return `d-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
}

/**
 * Parse the decisions of the answer of a reviewer.
 *
 * The answer must carry the key of the decisions: the list may be empty, but
 * the key must be there — a reviewer that answered without it did not do the
 * audit, and an audit that passes by silence is not an audit. An answer that
 * carries the key with a broken list is malformed too: the answer does not
 * report no decision, it reports a broken one. An entry that does not pass
 * the schema is invalid — it is reported, never silently dropped.
 *
 * Only a payload that carries the key of the decisions is read: a bare list of
 * findings is not a list of decisions. The last such payload is the answer —
 * a model that repeats the format of the answer puts the format first, and
 * the answer that follows is the one that counts.
 */
export function parseReviewerDecisions(text: string, role: ReviewRole): ParsedDecisions {
  const { candidates } = jsonCandidates(text);
  // A payload that carries the key of the decisions with a broken list is
  // reported wherever it is: a broken payload does not disappear because
  // another payload answers. An example of the format is no broken payload —
  // it is not an answer at all.
  const broken = candidates
    .filter((candidate) => !candidate.example)
    .map((candidate) => brokenDecisionsOf(candidate.value))
    .filter((note): note is string => note !== undefined);
  // The answer of the decisions is chosen like the answer of the findings: the
  // last payload that is not an example of the format. The answer is chosen
  // before it is read: a malformed answer is the answer, and it fails the step
  // instead of falling back to an earlier payload.
  const answer = answerCandidate(candidates, carriesTheShapeOfADecisionAnswer);
  if (!answer) {
    return {
      decisions: [],
      invalid: [...broken, 'the answer carries no decisions — the key is missing'],
    };
  }
  const entries = (answer.value as Record<string, unknown>).decisions as unknown[];
  const parsed = parseDecisionEntries(entries, role);
  return { decisions: parsed.decisions, invalid: [...parsed.invalid, ...broken] };
}

/** The decisions of one payload of an answer. */
function parseDecisionEntries(entries: unknown[], role: ReviewRole): ParsedDecisions {
  const decisions: Decision[] = [];
  const invalid: string[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid.push(`decisions[${index}]: the entry is not an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const decision = textOf(value.decision);
    if (!decision) {
      invalid.push(`decisions[${index}]: decision missing or malformed`);
      return;
    }
    const kind = decisionKindOf(value.kind);
    if (!kind) {
      invalid.push(`decisions[${index}]: kind missing or unknown`);
      return;
    }
    const previous = textOf(value.previous);
    if (!previous) {
      invalid.push(`decisions[${index}]: previous missing or malformed`);
      return;
    }
    const rationale = textOf(value.rationale);
    if (!rationale) {
      invalid.push(`decisions[${index}]: rationale missing or malformed`);
      return;
    }
    const consequence = textOf(value.consequence);
    if (!consequence) {
      invalid.push(`decisions[${index}]: consequence missing or malformed`);
      return;
    }
    const risk = textOf(value.risk);
    if (!risk) {
      invalid.push(`decisions[${index}]: risk missing or malformed`);
      return;
    }
    // The flag of the human is a flag: a value that is not a boolean is not
    // replaced by a default, it is a broken answer.
    if (typeof value.needsHuman !== 'boolean') {
      invalid.push(`decisions[${index}]: needsHuman missing or malformed`);
      return;
    }
    decisions.push({
      id: decisionId(decision),
      kind,
      decision,
      previous,
      rationale,
      consequence,
      risk,
      needsHuman: value.needsHuman,
      reportedBy: [role],
    });
  });
  return { decisions, invalid };
}

/**
 * Merge the decisions of the roles.
 *
 * Two roles that report the same decision report it once: the account of the
 * first one is kept, the roles that reported it are named, and the flag of the
 * human wins when one of them asks for it.
 */
export function dedupeDecisions(decisions: Decision[]): Decision[] {
  const merged = new Map<string, Decision>();
  for (const decision of decisions) {
    const known = merged.get(decision.id);
    if (!known) {
      merged.set(decision.id, { ...decision });
      continue;
    }
    known.reportedBy = [...new Set([...known.reportedBy, ...decision.reportedBy])];
    known.needsHuman = known.needsHuman || decision.needsHuman;
    // The most concrete kind wins: a change of behavior is more than an
    // assumption.
    if (DECISION_KINDS.indexOf(decision.kind) < DECISION_KINDS.indexOf(known.kind)) {
      known.kind = decision.kind;
    }
  }
  return [...merged.values()];
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
  // The answer of a verifier is chosen like the answer of a reviewer: the last
  // payload that is not an example of the format. A payload that carries more
  // verdicts is not the answer — an example of the format may carry more than
  // the answer does, and a finding confirmed by an example is a finding that
  // nobody verified. An answer that carries nothing but an example has not
  // answered, and the step of the verifier fails.
  //
  // The answer is chosen before it is read: a malformed answer is the answer,
  // and it fails the step instead of falling back to an earlier payload. A
  // verifier that answers "verdicts": "confirmed" would otherwise leave the
  // finding confirmed by the example of the format.
  const answer = answerCandidate(candidates, carriesTheShapeOfAVerdictionAnswer);
  if (!answer) {
    return {
      verdicts: [],
      invalid: ['the answer contains no JSON payload of verdicts', ...notes],
    };
  }
  // A bare list is the answer of a verifier that answered without the key.
  if (Array.isArray(answer.value)) {
    const parsed = parseVerdictEntries(answer.value);
    return { verdicts: parsed.verdicts, invalid: [...parsed.invalid, ...notes] };
  }
  const record = answer.value as Record<string, unknown>;
  if (!Array.isArray(record.verdicts)) {
    return {
      verdicts: [],
      invalid: ['the answer carries a verdicts field that is not a list of verdicts', ...notes],
    };
  }
  const parsed = parseVerdictEntries(record.verdicts);
  return { verdicts: parsed.verdicts, invalid: [...parsed.invalid, ...notes] };
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

/** The priority of a recommendation — only the two the report knows. */
function priorityOf(value: unknown): ImprovementPriority | undefined {
  const text = textOf(value)?.toUpperCase();
  return text === 'RECOMMENDED' || text === 'OPTIONAL' ? text : undefined;
}

/** Whether a recommendation should become separate follow-up work. */
function separateWorkOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const text = textOf(value)?.toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  return undefined;
}

/**
 * Parse the answer of the advisory improvement assessment.
 *
 * An empty list is a valid answer: "nothing to recommend" is a completed
 * assessment. A malformed entry is reported and dropped; a missing payload is
 * not an empty answer.
 *
 * The answer is chosen like the answer of a reviewer: the last payload that is
 * not an example of the format. The answer is chosen before it is read: a
 * malformed answer is the answer, and it is reported instead of falling back
 * to an earlier payload.
 */
export function parseImprovementRecommendations(text: string): ParsedImprovements {
  const { candidates, exhausted } = jsonCandidates(text);
  const notes = exhausted
    ? [
        `the answer carries more than ${MAX_JSON_CANDIDATES} delimiters without JSON — the payload may be missed`,
      ]
    : [];
  const answer = answerCandidate(candidates, carriesTheShapeOfARecommendationAnswer);
  if (!answer) {
    return {
      recommendations: [],
      invalid: ['the answer contains no JSON payload of recommendations', ...notes],
      missing: true,
    };
  }
  // A bare list is the answer of an assessment that answered without the key.
  if (Array.isArray(answer.value)) {
    const parsed = parseImprovementEntries(answer.value);
    return {
      recommendations: parsed.recommendations,
      invalid: [...parsed.invalid, ...notes],
      missing: false,
    };
  }
  const record = answer.value as Record<string, unknown>;
  if (!Array.isArray(record.recommendations)) {
    return {
      recommendations: [],
      invalid: ['the answer carries a recommendations field that is not a list of recommendations', ...notes],
      missing: false,
    };
  }
  const parsed = parseImprovementEntries(record.recommendations);
  return {
    recommendations: parsed.recommendations,
    invalid: [...parsed.invalid, ...notes],
    missing: false,
  };
}

/** The recommendations of one payload of an answer. */
function parseImprovementEntries(entries: unknown[]): Omit<ParsedImprovements, 'missing'> {
  const recommendations: ReviewImprovement[] = [];
  const invalid: string[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push(`recommendations[${index}]: the entry is not an object`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const title = textOf(value.title);
    const rationale = textOf(value.rationale);
    const evidence = evidenceOf(value.evidence);
    const benefit = textOf(value.benefit) ?? textOf(value.expectedBenefit);
    const scope = textOf(value.scope) ?? textOf(value.suggestedScope);
    const priority = priorityOf(value.priority);
    const separateWork = separateWorkOf(value.separateWork ?? value.separate);
    const missing = [
      title === undefined ? 'title' : undefined,
      rationale === undefined ? 'rationale' : undefined,
      evidence.length === 0 ? 'evidence' : undefined,
      benefit === undefined ? 'benefit' : undefined,
      scope === undefined ? 'scope' : undefined,
      priority === undefined ? 'priority' : undefined,
      separateWork === undefined ? 'separateWork' : undefined,
    ].filter((field): field is string => field !== undefined);
    if (
      missing.length > 0 ||
      title === undefined ||
      rationale === undefined ||
      benefit === undefined ||
      scope === undefined ||
      priority === undefined ||
      separateWork === undefined
    ) {
      invalid.push(`recommendations[${index}]: ${missing.join(', ')} missing or malformed`);
      return;
    }
    const existingSolution = textOf(value.existingSolution) ?? textOf(value.library);
    recommendations.push({
      title,
      rationale,
      evidence,
      benefit,
      scope,
      priority,
      ...(existingSolution ? { existingSolution } : {}),
      separateWork,
    });
  });

  return { recommendations, invalid };
}

/**
 * Whether a payload carries the shape of an answer of the assessment.
 *
 * A bare list is the answer of an assessment that answered without the key —
 * but only a list of entries: a list of strings is a list of the prose.
 */
function carriesTheShapeOfARecommendationAnswer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => !!entry && typeof entry === 'object');
  }
  if (!value || typeof value !== 'object') return false;
  // The presence of the key marks the payload of the answer, not its value: a
  // recommendations field that is not a list is a malformed answer, and it must
  // not pass as an answer without recommendations.
  return 'recommendations' in (value as Record<string, unknown>);
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
