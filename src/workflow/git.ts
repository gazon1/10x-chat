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

/** The git of the real checkout. */
export const nodeWorkflowGit: WorkflowGit = {
  async repository(cwd) {
    const remote = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
    return repositoryOf(remote);
  },

  async revParse(cwd, ref) {
    return git(['rev-parse', `${ref}^{commit}`], cwd);
  },

  async defaultBaseRef(cwd) {
    const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(
      () => '',
    );
    if (symbolic !== '') return symbolic.replace(/^origin\//, '');
    const branches = await git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
      cwd,
    ).catch(() => '');
    const candidates = branches
      .split('\n')
      .map((branch) => branch.trim().replace(/^origin\//, ''))
      .filter((branch) => branch !== '' && branch !== 'HEAD');
    // One branch of origin is not a guess — it is the only base there is.
    if (candidates.length === 1) return candidates[0];
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
};
