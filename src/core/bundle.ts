import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * The files that are never bundled — they may hold a secret.
 *
 * The patterns reach every directory: a name in the root and the same name
 * in a subdirectory are the same secret.
 */
export const SECRET_EXCLUDES = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_ed25519',
  '**/.credentials/**',
  '**/secrets/**',
  // A secret is a file as well as a directory: the name alone is enough.
  '**/.credentials',
  '**/secrets',
];

const DEFAULT_EXCLUDES = [
  'node_modules/**',
  'dist/**',
  'build/**',
  '.git/**',
  '.next/**',
  'coverage/**',
  '*.tgz',
  '.DS_Store',
  // Security: never bundle secrets
  ...SECRET_EXCLUDES,
];

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

/**
 * Pick a code-fence length longer than the longest backtick run in the content,
 * so files that themselves contain ``` fences (markdown, docs) don't break the
 * surrounding fence. Per CommonMark, a fenced block ends only at a fence of the
 * same or greater length, so we use (longest run + 1), with a minimum of 3.
 */
export function fenceFor(content: string): string {
  const runs = content.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The name of a file, as a label of the bundle.
 *
 * A name of Git may hold a newline and a control character: a name that
 * writes a line of its own writes into the prompt of the backend, and the
 * text of the repository looks like an instruction of the review. The
 * control characters are shown as they are, so that the name stays a name
 * and stays readable.
 */
function label(name: string): string {
  return [...name]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      return control ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
}

/**
 * The name of a file, as the inline code of a heading.
 *
 * A name of Git is a name of a file, and the name may hold words that look
 * like an instruction of the review. A heading of plain text reads as prose
 * of the prompt; the name in a code span reads as the name of a file, and it
 * cannot write a heading of its own.
 */
function inlineCode(name: string): string {
  const runs = name.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = '`'.repeat(longest + 1);
  // A code span that starts or ends with a backtick needs a space on that
  // side: the backtick would close the span otherwise.
  const pad = name.startsWith('`') || name.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${name}${pad}${fence}`;
}

/**
 * The language of a file, as the identifier of its fence.
 *
 * The identifier is a word: a name of Git may hold anything, and an
 * identifier that carries a newline would close the fence of the content.
 */
function language(filePath: string): string {
  const extension = path.extname(filePath).slice(1);
  return /^[a-z0-9+#]{1,16}$/i.test(extension) ? extension.toLowerCase() : 'txt';
}

interface BundleOptions {
  prompt: string;
  files?: string[];
  cwd?: string;
  /**
   * The reader of the content of a file — the disk by default.
   *
   * A review reads the files of the commit under review: the reader of the
   * pipeline reads the commit, so a file that changes on the disk while the
   * reviewers run does not reach the backend. The path is the one of the file
   * relative to the working directory, and `undefined` means that the file is
   * not there.
   */
  read?: (file: string) => Promise<string | undefined>;
}

/**
 * Assemble a markdown bundle from a prompt and file paths/globs.
 * Inspired by Oracle's bundle approach — one self-contained markdown document.
 */
export async function buildBundle(opts: BundleOptions): Promise<string> {
  const { prompt, files = [], cwd = process.cwd() } = opts;
  const parts: string[] = [];

  parts.push(prompt);
  parts.push('');

  if (files.length === 0) {
    return parts.join('\n');
  }

  // Resolve file globs
  const includes: string[] = [];
  const excludes: string[] = [...DEFAULT_EXCLUDES];

  for (const pattern of files) {
    if (pattern.startsWith('!')) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }

  const resolvedFiles = await fg(includes, {
    cwd,
    ignore: excludes,
    absolute: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    dot: false,
  });

  if (resolvedFiles.length === 0) {
    parts.push('> No files matched the provided patterns.\n');
    return parts.join('\n');
  }

  parts.push(`# Context Files (${resolvedFiles.length})\n`);

  for (const filePath of resolvedFiles.sort()) {
    const relativePath = path.relative(cwd, filePath);
    // The name is a label of the bundle: it is shown as it is, but it never
    // writes a line of its own.
    const name = label(relativePath);
    let content: string;
    if (opts.read) {
      const read = await opts.read(relativePath);
      if (read === undefined) {
        parts.push(`## ${inlineCode(name)} (SKIPPED — not in the revision)\n`);
        continue;
      }
      if (Buffer.byteLength(read) > MAX_FILE_SIZE) {
        parts.push(`## ${inlineCode(name)} (SKIPPED — exceeds 1 MB)\n`);
        continue;
      }
      content = read;
    } else {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) {
        parts.push(`## ${inlineCode(name)} (SKIPPED — exceeds 1 MB)\n`);
        continue;
      }
      content = await readFile(filePath, 'utf-8');
    }
    const ext = language(filePath);

    const fence = fenceFor(content);
    parts.push(`## ${inlineCode(name)}\n`);
    parts.push(`${fence}${ext}`);
    parts.push(content);
    parts.push(`${fence}\n`);
  }

  return parts.join('\n');
}
