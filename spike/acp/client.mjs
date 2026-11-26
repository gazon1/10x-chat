// Minimal ACP (Agent Client Protocol) client over stdio — spike only.
// Newline-delimited JSON-RPC 2.0, as implemented by `mcode acp`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export function createAcpClient({ command = 'mcode', args = ['acp'], cwd, env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const requestHandlers = new Map();
  const notificationHandlers = new Map();
  const seen = [];
  // a violation of the protocol is evidence, not noise: it is recorded instead
  // of being dropped, so a timeout is not mistaken for a missing answer
  const protocolErrors = [];
  let nextId = 1;
  let stderr = '';
  let buffer = '';
  // the reason the process died, kept for the requests that come after it
  let fatal = null;

  /** Records a violation of the protocol without keeping its content. */
  function protocolError(kind, bytes) {
    protocolErrors.push({
      kind,
      bytes,
      sha256: createHash('sha256').update(`${kind}:${bytes}`).digest('hex').slice(0, 12),
    });
  }

  /** Handles one message of the stream. */
  function dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      protocolError('malformed-line', line.length);
      return;
    }
    // valid JSON is not yet a message: a value that is not an object would
    // break the handler, so it is recorded like any other violation
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      protocolError('invalid-message', line.length);
      return;
    }
    // the envelope of JSON-RPC 2.0: a message that does not carry it is not
    // answered — a result of a broken envelope would be a result of nothing
    if (msg.jsonrpc !== '2.0') {
      protocolError('invalid-envelope', line.length);
      return;
    }
    seen.push(msg);
    handle(msg, line.length);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    for (;;) {
      idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      dispatch(line);
    }
  });
  // a message without its newline arrives with the end of the stream: it is
  // read, and only a broken remainder is a protocol error
  child.stdout.on('end', () => {
    const rest = buffer.trim();
    buffer = '';
    if (!rest) return;
    try {
      JSON.parse(rest);
    } catch {
      protocolError('unterminated-message', rest.length);
      return;
    }
    dispatch(rest);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // a closed pipe must not crash the harness
  child.stdin.on('error', () => {});

  /** Rejects every request that is still waiting: the process is gone, so no answer comes. */
  function failPending(err) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  child.on('error', (err) => {
    fatal = err;
    failPending(err);
  });
  child.on('exit', (code, signal) => {
    fatal = fatal ?? new Error(`acp process exited (code ${code}, signal ${signal ?? 'null'})`);
    failPending(fatal);
  });

  function write(obj) {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // the process is gone — the pending requests are rejected by the exit handler
    }
  }

  function handle(msg, bytes) {
    if (msg.method && msg.id !== undefined) {
      // request from the agent (e.g. session/request_permission)
      const handler = requestHandlers.get(msg.method);
      if (!handler) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        });
        return;
      }
      Promise.resolve(handler(msg.params))
        .then((result) => write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
        .catch((err) =>
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: String(err?.message ?? err) },
          }),
        );
      return;
    }
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      // a response carries a result or an error: a message that carries
      // neither is not an answer, and taking it for one would turn a broken
      // answer of the runtime into an empty one
      if (!('result' in msg) && !('error' in msg)) {
        protocolError('invalid-response', bytes);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.reject(new Error(`invalid response for request ${msg.id}: neither result nor error`));
        return;
      }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          Object.assign(new Error(msg.error.message ?? 'acp error'), {
            code: msg.error.code,
            data: msg.error.data,
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handler = notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  function request(method, params, { timeoutMs = 60000 } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // a request that comes after the process died never gets an answer
      if (fatal) {
        reject(fatal);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    child,
    request,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    onRequest: (method, handler) => requestHandlers.set(method, handler),
    onNotification: (method, handler) => notificationHandlers.set(method, handler),
    /** every message received on stdout, for the report */
    messages: () => seen,
    /** the violations of the protocol seen on stdout, for the report */
    protocolErrors: () => protocolErrors,
    stderr: () => stderr,
    close: async () => {
      child.stdin.end();
      // the exit must come from the end of stdin — a signal is only the
      // fallback of a process that does not leave on its own
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        let kill = null;
        const term = setTimeout(() => {
          child.kill('SIGTERM');
          kill = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2000);
        }, 3000);
        child.once('exit', () => {
          // the timers of the shutdown must not keep the harness alive
          clearTimeout(term);
          if (kill) clearTimeout(kill);
          resolve();
        });
      });
    },
  };
}

/** Collects the session/update stream of one session into a readable shape. */
export function collectUpdates(client, sessionId) {
  const updates = [];
  client.onNotification('session/update', (params) => {
    if (params?.sessionId && sessionId && params.sessionId !== sessionId) return;
    updates.push(params?.update ?? params);
  });
  return updates;
}

export function textOf(update) {
  if (!update) return '';
  if (update.sessionUpdate === 'agent_message_chunk') return update.content?.text ?? '';
  if (update.sessionUpdate === 'agent_thought_chunk') return update.content?.text ?? '';
  if (update.sessionUpdate === 'user_message_chunk') return update.content?.text ?? '';
  return '';
}
