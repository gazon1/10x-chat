import { execFile } from 'node:child_process';
import { repositoryOf } from '../pipeline/context.js';

/**
 * The git of a workflow.
 *
 * The workflow needs three things of the checkout: the repository it belongs
 * to, the ref the worktree starts from and the commit it ended at. They are
 * a seam, so that the unit tests of the workflow need no repository at all.
 */
export interface WorkflowGit {
  /** The `owner/name` of the repository of the checkout — empty when it has none. */
  repository(cwd: string): Promise<string>;
  /**
   * The URL of the origin remote of the checkout — empty when it has none.
   *
   * The host of the remote is part of the identity of the repository: the
   * same `owner/name` on two hosts is two repositories.
   */
  remoteUrl(cwd: string): Promise<string>;
  /** The commit of a ref. */
  revParse(cwd: string, ref: string): Promise<string>;
  /** The branch the worktrees are created from — the default branch of origin. */
  defaultBaseRef(cwd: string): Promise<string>;
  /** The root of the checkout — empty when the directory is not a repository. */
  root(cwd: string): Promise<string>;
  /**
   * The paths of the checkout that are not committed — empty when it is clean.
   *
   * The review reads the committed state of the worktree: a change that is not
   * committed is not in the review, and the workflow has to know it.
   */
  dirty(cwd: string): Promise<string[]>;
  /**
   * The common directory of the git of a checkout — the `.git` of the
   * repository the worktree belongs to.
   *
   * Two checkouts of one repository share it, and a checkout of another
   * repository does not: it is the proof that a worktree belongs to the
   * repository of the workflow.
   */
  commonDir(cwd: string): Promise<string>;
  /** The branch a checkout is on — empty when it has none. */
  branch(cwd: string): Promise<string>;
  /**
   * The physical root of a checkout — the top level of its git.
   *
   * The path of a checkout and the directory it is are two different things:
   * a symbolic link to the checkout of the user is a path of its own, and the
   * git of the checkout resolves it. The identity of a checkout is the
   * directory it really is, and not the path that names it.
   */
  toplevel(cwd: string): Promise<string>;
  /**
   * The main worktree of the repository of a checkout — empty when it cannot
   * be read.
   *
   * The worktrees of a repository are listed by its git, and the main one
   * comes first. The main worktree is the checkout of the user, and a
   * worktree of the workflow is never it.
   */
  mainWorktree(cwd: string): Promise<string>;
}

/** Run git and return what it says. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr).trim() || error.message;
          reject(new Error(`git ${args.join(' ')} failed: ${reason}`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

/** The host of a remote URL — the empty string when the URL has none. */
export function remoteHost(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  // `git@github.com:owner/name` — the form of a remote over ssh.
  const scp = /^[^@/]+@([^:/]+):/.exec(trimmed);
  if (scp) return scp[1].toLowerCase();
  // `https://host/owner/name` and `ssh://git@host/owner/name`.
  const url = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\//i.exec(trimmed);
  if (url) return url[1].toLowerCase();
  return '';
}

/**
 * The host of the identity of a repository — the empty string when it has none.
 *
 * The identity of Orca is `host/owner/name`: the host is a part of it, and a
 * registration of another host is a registration of another repository.
 */
export function canonicalHost(canonicalKey: string): string {
  const trimmed = canonicalKey.trim().replace(/\.git$/, '');
  const withoutScheme = trimmed.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  const parts = withoutScheme.split('/').filter((part) => part !== '');
  // `host/owner/name` names the host — `owner/name` does not.
  return parts.length >= 3 ? parts[0].toLowerCase() : '';
}

/** Whether a ref names a commit of the repository. */
async function resolvesToCommit(cwd: string, ref: string): Promise<boolean> {
  const sha = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).catch(
    () => '',
  );
  return sha !== '';
}

/**
 * The base ref as the repository knows it.
 *
 * The short name of a branch is not always a local branch: a clone that
 * fetched the remote only has `refs/remotes/origin/main`, and a `rev-parse`
 * of `main` fails there. The remote-tracking ref is the same commit and is
 * used when the local branch is absent.
 */
async function resolveBase(cwd: string, name: string): Promise<string> {
  if (await resolvesToCommit(cwd, name)) return name;
  const remote = `origin/${name}`;
  if (await resolvesToCommit(cwd, remote)) return remote;
  return name;
}

/** The git of the real checkout. */
export const nodeWorkflowGit: WorkflowGit = {
  async repository(cwd) {
    const remote = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
    return repositoryOf(remote);
  },

  async remoteUrl(cwd) {
    return git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
  },

  async revParse(cwd, ref) {
    return git(['rev-parse', `${ref}^{commit}`], cwd);
  },

  async defaultBaseRef(cwd) {
    const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(
      () => '',
    );
    if (symbolic !== '') return resolveBase(cwd, symbolic.replace(/^origin\//, ''));
    const branches = await git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
      cwd,
    ).catch(() => '');
    const candidates = branches
      .split('\n')
      .map((branch) => branch.trim().replace(/^origin\//, ''))
      .filter((branch) => branch !== '' && branch !== 'HEAD');
    // One branch of origin is not a guess — it is the only base there is.
    if (candidates.length === 1) return resolveBase(cwd, candidates[0]);
    // More than one branch is not a default branch: the order of the listing
    // says nothing about it, and a worktree of an unrelated branch is not a
    // worktree of the Issue.
    throw new Error(
      'The default branch of origin is unknown — the symbolic ref origin/HEAD is not set' +
        (candidates.length > 0 ? ` and origin has ${candidates.length} branches` : '') +
        '. Name the ref yourself: 10x-chat workflow start --base <ref>.',
    );
  },

  async root(cwd) {
    return git(['rev-parse', '--show-toplevel'], cwd).catch(() => '');
  },

  async dirty(cwd) {
    const status = await git(['status', '--porcelain'], cwd);
    return status
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  },

  async commonDir(cwd) {
    return git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd).catch(() => '');
  },

  async branch(cwd) {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '');
  },

  async toplevel(cwd) {
    // `--show-toplevel` names the directory the checkout really is: the git
    // resolves the symbolic links of the path it was given.
    return git(['rev-parse', '--show-toplevel'], cwd).catch(() => '');
  },

  async mainWorktree(cwd) {
    // The first entry of the list of the worktrees is the main one.
    const listed = await git(['worktree', 'list', '--porcelain'], cwd).catch(() => '');
    const line = listed.split('\n').find((entry) => entry.startsWith('worktree '));
    return line ? line.slice('worktree '.length).trim() : '';
  },
};
