import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

/**
 * A lock between the processes of the machine.
 *
 * The lock is an abstract unix socket — a name in the network namespace of
 * Linux that the kernel gives to exactly one process. Binding the name is
 * atomic: the second process gets `EADDRINUSE` and waits. The kernel takes
 * the name away when the holder dies, so a crash does not block the next run
 * and there is no stale lock to clean up.
 *
 * A file-based lock cannot do this: taking a dead lock over means replacing
 * the file at the path, and there is no way to replace it atomically — "only
 * if the dead lock is still there". Two processes can therefore both believe
 * that they own the lock. The socket has no such window: the kernel decides
 * who holds the lock, and it never gives it to two processes.
 *
 * The name of the socket is derived from the path of the lock, so every lock
 * of the project (the secrets store, a browser profile) has its own name.
 *
 * Inside one process the lock is a queue: the second caller of the same lock
 * waits for the first one instead of waiting for the socket.
 */

export interface Lock {
  /** The id of the holder — it names the lock in the messages of the user. */
  lockId: string;
  /** Give the lock back. */
  release: () => Promise<void>;
}

export interface LockOptions {
  /** How long to wait for a busy lock. */
  timeoutMs?: number;
  /** The interval between two attempts. */
  pollMs?: number;
  /** What to tell the user when the lock cannot be taken. */
  hint?: string;
}

/** The tail of the in-process queue of every lock. */
const queues = new Map<string, Promise<void>>();

/**
 * Acquire the lock of a directory.
 *
 * @param dir the directory the lock belongs to
 * @param filename the name of the lock
 * @param options the timeout, the poll interval and the hint
 */
export async function acquireLock(
  dir: string,
  filename: string,
  options: LockOptions = {},
): Promise<Lock> {
  if (process.platform !== 'linux') {
    throw new Error('The lock of 10x-chat is an abstract unix socket — it works on Linux only.');
  }

  const target = path.resolve(dir, filename);
  const name = socketName(target);

  // The queue of the lock: the caller waits for the previous holder of the
  // same lock inside this process.
  const previous = queues.get(target) ?? Promise.resolve();
  let finish: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const chained = previous.then(() => mine);
  queues.set(target, chained);

  await previous;

  let lock: Lock;
  try {
    lock = await bind(name, target, options);
  } catch (error) {
    finish();
    if (queues.get(target) === chained) queues.delete(target);
    throw error;
  }

  return {
    lockId: lock.lockId,
    release: async () => {
      try {
        await lock.release();
      } finally {
        // The queue is free together with the lock — not when it is taken.
        finish();
        if (queues.get(target) === chained) queues.delete(target);
      }
    },
  };
}

/**
 * The name of the socket of a lock.
 *
 * The name is derived from the path of the lock, so the same lock is the
 * same name in every run and in every process. The user is part of it: the
 * names of the abstract sockets are shared by the whole machine.
 */
function socketName(target: string): string {
  const hash = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return `\0ten-x-chat-lock-${process.getuid?.() ?? 0}-${hash}`;
}

/**
 * The name of the socket of the lock of a directory.
 *
 * The name is public: the tests connect to it to prove that a foreign
 * connection cannot hold the lock.
 *
 * @param dir the directory the lock belongs to
 * @param filename the name of the lock
 */
export function lockSocketName(dir: string, filename: string): string {
  return socketName(path.resolve(dir, filename));
}

/**
 * Bind the name of the lock — the kernel gives it to one process only.
 *
 * @param name the name of the abstract socket
 * @param target the path of the lock — it is in the message of the error
 * @param options the timeout, the poll interval and the hint
 */
async function bind(name: string, target: string, options: LockOptions): Promise<Lock> {
  const { timeoutMs = 30_000, pollMs = 500, hint } = options;
  const lockId = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const server = net.createServer();
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve);
      server.listen({ path: name }, () => resolve(null));
    });

    if (!error) {
      // The name is ours. An error of the socket must not crash the process.
      server.on('error', () => {});
      // Nobody talks to the lock — it has no protocol. A connection that stays
      // open would keep `server.close()` waiting at the release of the lock,
      // and a stranger that connects at the wrong moment would delay it. The
      // connection is destroyed at once.
      server.on('connection', (socket) => socket.destroy());
      return handle(server, lockId);
    }

    server.close(() => {});
    if (error.code !== 'EADDRINUSE') {
      throw new Error(`Cannot take the lock of ${target}: ${error.message}`);
    }

    // The lock is held by another process — wait for it.
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `Failed to acquire the lock at ${target} within ${timeoutMs}ms.` + (hint ? ` ${hint}` : ''),
  );
}

/** The handle of a lock that this process owns. */
function handle(server: net.Server, lockId: string): Lock {
  let released = false;
  return {
    lockId,
    release: async () => {
      if (released) return;
      released = true;
      // Every connection of the server was destroyed when it came in — the
      // close does not wait for a stranger.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
