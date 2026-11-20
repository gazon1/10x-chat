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
    let content: string;
    if (opts.read) {
      const read = await opts.read(relativePath);
      if (read === undefined) {
        parts.push(`## ${relativePath} (SKIPPED — not in the revision)\n`);
        continue;
      }
      if (Buffer.byteLength(read) > MAX_FILE_SIZE) {
        parts.push(`## ${relativePath} (SKIPPED — exceeds 1 MB)\n`);
        continue;
      }
      content = read;
    } else {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) {
        parts.push(`## ${relativePath} (SKIPPED — exceeds 1 MB)\n`);
        continue;
      }
      content = await readFile(filePath, 'utf-8');
    }
    const ext = path.extname(filePath).slice(1) || 'txt';

    const fence = fenceFor(content);
    parts.push(`## ${relativePath}\n`);
    parts.push(`${fence}${ext}`);
    parts.push(content);
    parts.push(`${fence}\n`);
  }

  return parts.join('\n');
}
