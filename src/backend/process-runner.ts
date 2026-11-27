import { spawn } from 'node:child_process';

/** The result of a process of the runner. */
export interface ProcessResult {
  /** The exit code of the process — `null` when it was killed. */
  code: number | null;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
  /** The process was killed: it did not finish in time. */
  timedOut: boolean;
  /** The process was cancelled by an AbortSignal. */
  cancelled?: boolean;
}

/** How the adapter starts a process — the seam the unit tests replace. */
export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; input?: string; signal?: AbortSignal },
  ): Promise<ProcessResult>;
}

/** The grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * The runner of the real processes.
 *
 * The process is started without a shell, so a prompt or a path is never
 * interpolated into a command line.
 */
export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: 'aborted', timedOut: false, cancelled: true });
        return;
      }
      const child = spawn(command, args, {
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        cancelled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // process may already be gone
        }
        killTimer ??= setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, KILL_GRACE_MS);
      };
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (options.input !== undefined) {
        // The stdin of the process is closed after the input: the CLI reads it
        // until the end and then it has the whole of it. A process that dies
        // before it reads the whole of it breaks the pipe: the exit code of
        // the process says why it died, and the broken pipe is not a crash.
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.input);
      }
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
            // A process that ignores SIGTERM must not keep the run pending
            // forever: it is killed after the grace period.
            killTimer ??= setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // ignore
              }
            }, KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr, timedOut, ...(cancelled ? { cancelled: true } : {}) });
      });
    });
  },
};
