// Spike: MCode ACP session lifecycle and interactive control (issue #86).
// Disposable experiment — it does not touch production code.
//
// Protocol facts this script relies on (mcode 0.7.10, verified against the bundle):
//   - `session/cancel` is a NOTIFICATION (client -> agent), not a request.
//   - `session/set_config_option` takes {sessionId, configId, value}; configId is
//     `permissionMode` | `model` | `thinkingEffort`.
//   - `session/activate` only marks a session that this very process owns as current.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideBoundary } from './boundary.mjs';
import { collectUpdates, createAcpClient, textOf } from './client.mjs';
import { sanitizeReport } from './sanitize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, 'results/report.json');
const WORKDIR = process.env.SPIKE_WORKDIR || resolve(HERE, '.workdir');
const LONG_PROMPT =
  'Write a detailed essay of about 1500 words about the history of the bicycle. Do not stop early.';
// The transcript of a session is checked by its content, not by its position: the
// first user-role message of a session is a runtime system reminder, so "what was
// your first message" is answered by the reminder and proves nothing. The two
// one-word answers of the first two prompts are the marker of the transcript.
const HISTORY_QUESTION =
  'I sent you two short messages in this session, each asking you to reply with a single word. Quote both of them exactly.';
const HISTORY_MARKERS = ['PONG1', 'PONG2'];
const hasHistory = (text) =>
  HISTORY_MARKERS.every((marker) => new RegExp(marker, 'i').test(text ?? ''));
// A live interactive TUI session of this machine (the id of the session that runs the
// spike itself, or any other TUI session id). Used for the "can a TUI be attached?" test.
const TUI_SESSION_ID = process.env.SPIKE_TUI_SESSION_ID || '';
// the log of the TUI session: the explicit path wins, otherwise the store of the
// runtime is searched for the session id
const TUI_SESSION_FILE = process.env.SPIKE_TUI_SESSION_FILE || '';
// The config file of the runtime: the state of the machine itself. The spike only
// reads it — the write is the business of the runtime, and the question is whether
// a turn changes it. Only the hash and the names of the keys are published.
const RUNTIME_CONFIG =
  process.env.SPIKE_RUNTIME_CONFIG || resolve(homedir(), '.minimax/config.yaml');

/** The model of the file and the model of the session in one spelling. */
const sameModel = (a, b) => {
  const norm = (value) =>
    decodeURIComponent(String(value ?? ''))
      .replace(/^m:/, '')
      .replace(/:v:[^:]*$/, '')
      .replace(/:/g, '/')
      .toLowerCase();
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
};

/** The hash and the top-level keys of the config file of the runtime (or null). */
function configSnapshot() {
  try {
    const raw = readFileSync(RUNTIME_CONFIG, 'utf8');
    const keys = [...raw.matchAll(/^([A-Za-z][\w.-]*):/gm)].map((m) => m[1]);
    const model = raw.match(/^defaultModel:\s*(.+)$/m)?.[1]?.trim() ?? null;
    // the hash of the value of every top-level section: it says *which* section
    // the runtime rewrites without publishing the value itself
    const values = {};
    let section = null;
    let lines = [];
    const flush = () => {
      if (section) {
        values[section] = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
      }
    };
    for (const line of raw.split('\n')) {
      const m = /^([A-Za-z][\w.-]*):/.exec(line);
      if (m) {
        flush();
        section = m[1];
        lines = [line];
      } else if (section) {
        lines.push(line);
      }
    }
    flush();
    return {
      hash: createHash('sha256').update(raw).digest('hex').slice(0, 12),
      keys: [...new Set(keys)].sort(),
      values,
      model,
    };
  } catch {
    return null;
  }
}

const report = {
  meta: {
    issue: 86,
    startedAt: new Date().toISOString(),
    mcode: null,
    workdir: WORKDIR,
    tuiSessionId: TUI_SESSION_ID || null,
  },
  steps: [],
};

// Every client of the run, so that the violations of the protocol reach the
// report from all of them: a violation in a second process is a violation of
// the run, not of one client.
const clients = [];
const newClient = (options) => {
  const client = createAcpClient(options);
  clients.push(client);
  return client;
};

const log = (...args) => console.log('[spike]', ...args);

/** The report is public: the machine data of a run is replaced before it is written. */
function writeReport() {
  writeFileSync(RESULTS, `${JSON.stringify(sanitizeReport(report), null, 2)}\n`);
}

async function step(name, fn) {
  const entry = { name, startedAt: new Date().toISOString(), ok: false, status: 'failed' };
  report.steps.push(entry);
  log('---', name);
  try {
    const outcome = (await fn(entry)) ?? {};
    Object.assign(entry, outcome);
    // An experiment that could not run is not an experiment that worked: `ok` is
    // only true when the step really ran and produced its evidence.
    entry.status =
      outcome.status ??
      (outcome.inconclusive ? 'inconclusive' : outcome.skipped ? 'skipped' : 'ok');
    entry.ok = entry.status === 'ok';
  } catch (err) {
    entry.error = String(err?.message ?? err);
    entry.code = err?.code;
    entry.status = 'failed';
    entry.ok = false;
    log('FAILED', name, entry.error);
  }
  entry.durationMs = Date.now() - new Date(entry.startedAt).getTime();
  log('done', name, entry.status, `${entry.durationMs}ms`);
  // the report is written after every step: a run that dies leaves its evidence
  writeReport();
  return entry;
}

/** A call that never throws: the spike records the error instead of losing the step. */
async function attempt(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), code: err?.code };
  }
}

const mcodeVersion = () => {
  try {
    return execFileSync('mcode', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

// The findings of the spike are the findings of one version of MCode. Another
// version may move the extension methods, so the run refuses it — unless the
// caller insists and knows what it is measuring.
const VERIFIED_MCODE_VERSION = '0.7.10';

/**
 * Answers the permission requests of the agent.
 *
 * The spike answers them automatically — a test behavior, never a production
 * policy. The narrowest answer is preferred: a single allowance inside the
 * boundary of the experiment, otherwise a rejection. A permanent grant is never
 * used.
 */
async function connect(cwd, allowedRoots = () => [cwd]) {
  const client = newClient({ cwd });
  const permissionRequests = [];
  const refusedOutsideBoundary = [];
  client.onRequest('session/request_permission', async (params) => {
    permissionRequests.push(params);
    const options = params?.options ?? [];
    const inside = insideBoundary(params?.toolCall, allowedRoots());
    if (!inside) refusedOutsideBoundary.push(params?.toolCall?.title ?? params?.toolCall?.kind);
    const wanted = inside ? 'allow_once' : 'reject_once';
    const chosen =
      options.find((o) => o.kind === wanted) ?? options.find((o) => o.kind === 'reject_once');
    // Without a narrow option the request is cancelled rather than answered with
    // an arbitrary one: a fallback would grant a permanent permission.
    if (!chosen) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
  });
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  // The permission mode is process scoped, but `session/set_config_option` needs a
  // session id — so it can only be set once the session exists (see the permission step).
  return { client, init, permissionRequests, refusedOutsideBoundary };
}

// The evidence of an answer, without the answer itself.
//
// The report is public and an answer of a model can hold anything the model
// saw. What is published is what can be checked without reading the text:
// the length, the hash of the text and whether it holds the marker of the
// step.
const answerEvidence = (text, marker) => {
  const value = text ?? '';
  return {
    chars: value.length,
    sha256: createHash('sha256').update(value).digest('hex').slice(0, 12),
    ...(marker ? { markerMatched: new RegExp(marker, 'i').test(value) } : {}),
  };
};

// A turn that ended is a protocol success; the marker is the content question
// of the same step. A turn that ended without the marker leaves the step
// inconclusive — the model answered something else.
const turnVerdict = (r, marker) => {
  const ended = r?.stopReason === 'end_turn';
  const markerMatched = new RegExp(marker, 'i').test(r?.agentText ?? '');
  return {
    ended,
    markerMatched,
    status: ended ? (markerMatched ? undefined : 'inconclusive') : 'failed',
    note: ended
      ? markerMatched
        ? undefined
        : `the turn ended, but the answer does not contain ${marker}`
      : `the turn did not end (${r?.stopReason})`,
  };
};

async function prompt(client, sessionId, text, { timeoutMs = 240000 } = {}) {
  const updates = collectUpdates(client, sessionId);
  const result = await client.request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text }] },
    { timeoutMs },
  );
  const agent = updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map(textOf)
    .join('');
  return {
    stopReason: result?.stopReason,
    turn: result?._meta?.['minimax-code/turn'],
    usage: result?.usage,
    agentText: agent,
    updateKinds: [...new Set(updates.map((u) => u.sessionUpdate))],
    updateCount: updates.length,
  };
}

// A turn announces itself with a thought chunk and writes its answer with a
// message chunk: any of them proves that the turn is running.
const AGENT_CHUNKS = ['agent_message_chunk', 'agent_thought_chunk'];

/**
 * Follows the state of a prompt: the turn may end between the first chunk and
 * the operation of the experiment, and an operation on a turn that already
 * ended would land in the next turn.
 */
function promptState(promise) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

/**
 * Waits until the agent produced its first chunk (the turn is then steerable).
 *
 * The prompt completion wins the race: a turn that already ended cannot be
 * steered, queued or cancelled, and an operation on it would land in the next
 * experiment. The caller skips the operation when the answer is `prompt-done`.
 */
function waitForAgentChunk(updates, promptPromise, timeoutMs = 120000) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const sawChunk = () => updates.some((u) => AGENT_CHUNKS.includes(u.sessionUpdate));
    const settle = (value) => {
      clearInterval(timer);
      resolvePromise(value);
    };
    const timer = setInterval(() => {
      if (sawChunk()) settle('chunk');
      else if (Date.now() - started > timeoutMs) settle('timeout');
    }, 100);
    promptPromise.then(
      () => settle(sawChunk() ? 'chunk' : 'prompt-done'),
      () => settle(sawChunk() ? 'chunk' : 'prompt-done'),
    );
  });
}

const fileStamp = (path) => {
  try {
    const s = statSync(path);
    // the hash is the decisive stamp: a rewrite of the same length leaves the
    // size untouched, so the size alone cannot prove that nothing changed
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    return { size: s.size, mtimeMs: s.mtimeMs, hash };
  } catch {
    return null;
  }
};

/** Removes the ANSI escape sequences of a terminal output. */
const stripAnsi = (text) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g'), '');

async function main() {
  mkdirSync(WORKDIR, { recursive: true });
  mkdirSync(dirname(RESULTS), { recursive: true });
  const version = mcodeVersion();
  report.meta.mcode = version;
  log('mcode', version);
  // the findings document describes one version — a run on another one would
  // measure something else and would be read as evidence for 0.7.10
  const semver = version.match(/\d+\.\d+\.\d+/)?.[0] ?? version;
  if (semver !== VERIFIED_MCODE_VERSION && process.env.SPIKE_ALLOW_ANY_VERSION !== '1') {
    throw new Error(
      `mcode ${version}: the spike was verified against ${VERIFIED_MCODE_VERSION} — set SPIKE_ALLOW_ANY_VERSION=1 to run it against another version anyway`,
    );
  }

  let client;
  let init;
  let sessionId;
  // the model of the machine, read from `session/new`: it is restored after the
  // experiment, so the run leaves the configuration as it found it
  let originalModel = null;

  // the state of the config file of the machine before anything runs: the
  // handshake and the creation of a session are compared with it
  const configAtStart = configSnapshot();

  await step('handshake', async () => {
    ({ client, init } = await connect(WORKDIR));
    const ext = init?._meta?.['minimax-code/extensions'];
    return {
      protocolVersion: init?.protocolVersion,
      agentInfo: init?.agentInfo,
      agentCapabilities: init?.agentCapabilities,
      extensionMethods: ext?.methods,
      extensionNotifications: ext?.notifications,
    };
  });

  // the state of the config file of the machine after the handshake: it
  // separates the handshake from the creation of the session
  const configAfterHandshake = configSnapshot();

  // The runtime answers `session/new` with an internal error from time to time
  // (the project of the cwd cannot be resolved at that moment): one retry.
  //
  // Only that refusal is retried. A refusal carries the code of the runtime and
  // means that no session was created; a timeout or a lost answer carries no
  // code and is ambiguous — the session may exist, and the retry would
  // leave a second one behind. The same holds for an internal error of
  // another kind: it is not this refusal, and it may have had a side effect.
  const newSession = async (c) => {
    const first = await attempt(() => c.request('session/new', { cwd: WORKDIR, mcpServers: [] }));
    if (first.ok) return first;
    if (first.code !== -32603 || !/could not be resolved/i.test(first.error ?? '')) return first;
    const second = await attempt(() => c.request('session/new', { cwd: WORKDIR, mcpServers: [] }));
    return { ...second, retriedAfter: first.error };
  };
  // Every interaction experiment runs in its own session: a turn that hangs
  // leaves its session busy, and the next experiment would be refused with
  // "A prompt is already active for this session".
  const freshSession = async () => {
    const created = await newSession(client);
    return created.ok ? created.result?.sessionId : null;
  };

  await step('session/new', async () => {
    const created = await newSession(client);
    if (!created.ok) return { status: 'failed', created };
    const result = created.result;
    sessionId = result?.sessionId;
    originalModel = result?.configOptions?.find((o) => o.id === 'model')?.currentValue ?? null;
    return {
      sessionId,
      // the first refusal of the runtime is evidence: the retry is visible
      retriedAfter: created.retriedAfter,
      modes: result?.modes?.availableModes?.map((m) => m.id),
      configOptions: result?.configOptions?.map((o) => ({
        id: o.id,
        current: o.currentValue,
        scope: o._meta?.['minimax-code/scope'],
      })),
    };
  });

  // the state of the config file of the machine after the session exists and
  // before the model of the session is touched: it separates the two events
  const configAfterSession = configSnapshot();

  await step('session/set_config_option (model)', async () => {
    // The default model of this machine is a custom provider. Switching to the
    // `minimax` provider is accepted by the runtime but the turn then fails
    // (managed OAuth bearer not synced) — the original model is restored below.
    // The provider of the custom model is taken from the model of the session:
    // the source of the spike must not carry the id of the account of the machine.
    const customProvider = originalModel?.match(/^(m:custom_provider%3A[^:]+):/)?.[1];
    const values = [
      'm:minimax:MiniMax-M3.1-Flash:v:',
      ...(customProvider ? [`${customProvider}:MiniMax-M2.7:v:`] : []),
    ];
    const attempts = [];
    for (const value of values) {
      attempts.push({
        value,
        ...(await attempt(() =>
          client.request('session/set_config_option', { sessionId, configId: 'model', value }),
        )),
      });
    }
    // the value that `session/new` reported, not a hard-coded one: the run
    // restores the model of this machine, whatever it is
    const restore = originalModel
      ? await attempt(() =>
          client.request('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: originalModel,
          }),
        )
      : { ok: false, error: 'session/new reported no model configOption' };
    // the state of the option in the answer of the runtime is what proves the
    // restore: an accepted call alone does not say that the model is the one of
    // the machine again
    const restoredModel = restore.ok
      ? (restore.result?.configOptions?.find((o) => o.id === 'model')?.currentValue ?? null)
      : null;
    const restoreVerified = restoredModel === null ? null : restoredModel === originalModel;
    return {
      attempts,
      // the answer of the runtime carries the whole catalogue of the models of
      // the machine — only the state of the option is kept
      restore: {
        ok: restore.ok,
        error: restore.error,
        model: originalModel,
        restoredModel,
        // `null` when the runtime does not report the state of the option
        verified: restoreVerified,
        advertisedModels: restore.ok
          ? (restore.result?.configOptions?.find((o) => o.id === 'model')?.options?.length ?? null)
          : null,
      },
      // the observation of the step is the refusal of the selection of the model
      // that works on this machine — the restore is mandatory: a run that leaves
      // the model of the machine changed is not a successful experiment
      selectionRefused: attempts.some((a) =>
        /Model selection is not advertised/i.test(String(a.error ?? '')),
      ),
      status: restore.ok && restoreVerified !== false ? undefined : 'failed',
      note:
        restore.ok && restoreVerified !== false
          ? undefined
          : restoreVerified === false
            ? 'the model of the machine was not restored'
            : 'the model could not be restored',
    };
  });

  // the state of the config file of the machine before the first turn: the turn
  // that follows is the one that is compared with it
  const configBeforeTurn = configSnapshot();

  await step('prompt-1 (streaming, completion)', async () => {
    const r = await prompt(client, sessionId, 'Reply with exactly: PONG1');
    return {
      ...turnVerdict(r, 'PONG1'),
      stopReason: r.stopReason,
      answer: answerEvidence(r.agentText),
      updateKinds: r.updateKinds,
      updateCount: r.updateCount,
      turn: r.turn,
    };
  });

  await step('runtime config file (side effect of a session and of a turn)', async () => {
    const after = configSnapshot();
    if (
      !configAtStart ||
      !configAfterHandshake ||
      !configAfterSession ||
      !configBeforeTurn ||
      !after
    ) {
      return {
        inconclusive: true,
        note: 'the config file of the runtime could not be read',
      };
    }
    return {
      // the question of the step: does a turn rewrite the file of the machine?
      changed: configAtStart.hash !== after.hash,
      // the two parts of the answer: the handshake and the session leave the
      // file alone, the turn does not
      changedBeforeTurn: configAtStart.hash !== configBeforeTurn.hash,
      changedByTurn: configBeforeTurn.hash !== after.hash,
      // which of the events before the turn wrote the file: the handshake, the
      // creation of the session or the change of the model of the session
      changedByHandshake: configAtStart.hash !== configAfterHandshake.hash,
      changedBySession: configAfterHandshake.hash !== configAfterSession.hash,
      changedByModelOption: configAfterSession.hash !== configBeforeTurn.hash,
      beforeHash: configAtStart.hash,
      afterHash: after.hash,
      // does the file name the model that served the turn? the runtime writes
      // its resolved state into the file, so the content changes when the two
      // differ — the strings themselves are not published (they are the state
      // of the machine)
      namesServedModel: sameModel(after.model, originalModel),
      // the names of the keys only — the values are the state of the machine
      addedKeys: after.keys.filter((k) => !configAtStart.keys.includes(k)),
      removedKeys: configAtStart.keys.filter((k) => !after.keys.includes(k)),
      // the keys whose value the runtime rewrote — the value itself is the
      // state of the machine and stays unpublished
      changedKeys: after.keys.filter(
        (k) => configAtStart.values[k] !== undefined && configAtStart.values[k] !== after.values[k],
      ),
    };
  });

  await step('prompt-2 (same session)', async () => {
    const r = await prompt(client, sessionId, 'Reply with exactly: PONG2');
    return {
      ...turnVerdict(r, 'PONG2'),
      stopReason: r.stopReason,
      answer: answerEvidence(r.agentText),
      updateKinds: r.updateKinds,
    };
  });

  await step('session/list', async () => {
    const result = await client.request('session/list', { cwd: WORKDIR });
    const sessions = result?.sessions ?? [];
    // the shape of an entry, not its content: the titles and the ids of the
    // conversations of the machine are not published
    return {
      count: sessions.length,
      entryKeys: sessions[0] ? Object.keys(sessions[0]) : [],
      hasNextCursor: result?.nextCursor !== undefined && result?.nextCursor !== null,
    };
  });

  await step('session/activate (own session)', async () => {
    const r = await attempt(() =>
      client.request('session/activate', { sessionId }, { timeoutMs: 30000 }),
    );
    // the question of the experiment is whether the session can be activated
    // at all: a refused activation is not a successful step
    return {
      activated: r.ok,
      status: r.ok ? undefined : 'failed',
      attempt: r,
    };
  });

  await step('steer (during an active turn)', async () => {
    const sid = await freshSession();
    if (!sid) return { inconclusive: 'the session could not be created' };
    const updates = collectUpdates(client, sid);
    const promptPromise = client
      .request(
        'session/prompt',
        { sessionId: sid, prompt: [{ type: 'text', text: LONG_PROMPT }] },
        // the essay turn of a slow model needs more than the default window:
        // the steer can only be observed while the turn is still running
        { timeoutMs: 600000 },
      )
      .catch((err) => ({ stopReason: `error: ${err.message}` }));
    const state = promptState(promptPromise);
    const turn = await waitForAgentChunk(updates, promptPromise);
    if (turn !== 'chunk' || state.settled) {
      // the turn was over before it could be steered: the operation is skipped
      const result = await promptPromise;
      await attempt(() => client.request('session/close', { sessionId: sid }));
      return {
        inconclusive: state.settled
          ? 'the turn ended before the steer'
          : `no agent chunk (${turn})`,
        stopReason: result?.stopReason,
      };
    }
    const steer = await attempt(() =>
      client.request(
        'mcode/session/steer',
        { sessionId: sid, text: 'Stop writing the essay and reply with exactly: STEERED' },
        { timeoutMs: 60000 },
      ),
    );
    const result = await promptPromise;
    const agent = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map(textOf)
      .join('');
    await attempt(() => client.request('session/close', { sessionId: sid }));
    const acknowledged = /STEERED/.test(agent);
    return {
      sawAgentChunk: true,
      steer,
      // The RPC acceptance is not the behaviour: the turn has to answer the
      // steer. A refused call is a failure, a call that was accepted but never
      // acted upon is inconclusive — the experiment did not measure what it
      // claims to measure.
      status: !steer.ok ? 'failed' : acknowledged ? undefined : 'inconclusive',
      steerAccepted: Boolean(steer.ok),
      steerAcknowledged: acknowledged,
      note: acknowledged
        ? undefined
        : 'the steer was accepted, but the turn did not answer it before it ended',
      stopReason: result?.stopReason,
      answer: answerEvidence(agent),
    };
  });

  await step('queue/enqueue + queue/list (during an active turn)', async () => {
    const sid = await freshSession();
    if (!sid) return { inconclusive: 'the session could not be created' };
    const updates = collectUpdates(client, sid);
    const queueNotifications = [];
    client.onNotification('mcode/session/queue_update', (p) => queueNotifications.push(p));
    const promptPromise = client
      .request(
        'session/prompt',
        { sessionId: sid, prompt: [{ type: 'text', text: LONG_PROMPT }] },
        { timeoutMs: 240000 },
      )
      .catch((err) => ({ stopReason: `error: ${err.message}` }));
    const state = promptState(promptPromise);
    const turn = await waitForAgentChunk(updates, promptPromise);
    if (turn !== 'chunk' || state.settled) {
      // nothing is enqueued: a message that is never merged would be consumed
      // by the next prompt of the spike
      const result = await promptPromise;
      await attempt(() => client.request('session/close', { sessionId: sid }));
      return {
        inconclusive: state.settled
          ? 'the turn ended before the enqueue'
          : `no agent chunk (${turn})`,
        stopReason: result?.stopReason,
      };
    }
    const enqueue = await attempt(() =>
      client.request(
        'mcode/session/queue/enqueue',
        { sessionId: sid, text: 'QUEUED-FOLLOWUP' },
        { timeoutMs: 60000 },
      ),
    );
    const listDuring = await attempt(() =>
      client.request('mcode/session/queue/list', { sessionId: sid }, { timeoutMs: 30000 }),
    );
    const result = await promptPromise;
    const listAfter = await attempt(() =>
      client.request('mcode/session/queue/list', { sessionId: sid }, { timeoutMs: 30000 }),
    );
    // a message that was not merged into the turn would be picked up by the
    // next prompt — it is removed so the following steps stay clean
    const leftover = listAfter.ok ? (listAfter.result?.items ?? listAfter.result?.queue ?? []) : [];
    let cleanup = null;
    if (Array.isArray(leftover) && leftover.length > 0 && enqueue.ok) {
      cleanup = await attempt(() =>
        client.request(
          'mcode/session/queue/delete',
          { sessionId: sid, itemId: leftover[0]?.itemId },
          { timeoutMs: 30000 },
        ),
      );
    }
    const agent = updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map(textOf)
      .join('');
    await attempt(() => client.request('session/close', { sessionId: sid }));
    // the question of the experiment is what happens to the message after the
    // turn: a turn that never ended answers nothing
    const turnEnded =
      Boolean(result?.stopReason) && !String(result.stopReason).startsWith('error:');
    return {
      enqueue,
      // the enqueue call is the experiment: a refusal is not a successful step,
      // and a turn that was cut off cannot say what happened to the message
      status: !enqueue.ok ? 'failed' : turnEnded ? undefined : 'inconclusive',
      turnEnded,
      note: turnEnded ? undefined : 'the turn did not end — the fate of the message is unknown',
      listDuring,
      listAfter,
      queueNotifications: queueNotifications.length,
      queuedDelivered: /QUEUED-FOLLOWUP/.test(agent),
      queuedLeftover: Array.isArray(leftover) ? leftover.length : null,
      cleanup,
      stopReason: result?.stopReason,
      answer: answerEvidence(agent),
    };
  });

  await step('session/cancel (notification, active turn)', async () => {
    const sid = await freshSession();
    if (!sid) return { inconclusive: 'the session could not be created' };
    const updates = collectUpdates(client, sid);
    const promptPromise = client
      .request(
        'session/prompt',
        { sessionId: sid, prompt: [{ type: 'text', text: LONG_PROMPT }] },
        { timeoutMs: 240000 },
      )
      .catch((err) => ({ stopReason: `error: ${err.message}` }));
    const state = promptState(promptPromise);
    const turn = await waitForAgentChunk(updates, promptPromise);
    if (turn !== 'chunk' || state.settled) {
      // a turn that is over cannot be cancelled: it would cancel nothing
      const result = await promptPromise;
      await attempt(() => client.request('session/close', { sessionId: sid }));
      return {
        inconclusive: state.settled
          ? 'the turn ended before the cancel'
          : `no agent chunk (${turn})`,
        stopReason: result?.stopReason,
      };
    }
    client.notify('session/cancel', { sessionId: sid });
    const result = await promptPromise;
    await attempt(() => client.request('session/close', { sessionId: sid }));
    return {
      // the experiment is the cancellation: a turn that ended on its own is not
      // a cancelled turn
      status: result?.stopReason === 'cancelled' ? undefined : 'failed',
      stopReason: result?.stopReason,
      result,
      updateKinds: [...new Set(updates.map((u) => u.sessionUpdate))],
      answer: answerEvidence(
        updates
          .filter((u) => u.sessionUpdate === 'agent_message_chunk')
          .map(textOf)
          .join(''),
      ),
    };
  });

  await step('session/close', async () => {
    const result = await client.request('session/close', { sessionId });
    return { result };
  });

  await step('process exit', async () => {
    // the exit code proves the shutdown only when no signal was needed: the
    // client ends stdin and waits before it sends one
    const exit = await new Promise((resolvePromise) => {
      client.child.once('exit', (code, signal) => resolvePromise({ code, signal }));
      client.close();
    });
    return { exitCode: exit.code, signal: exit.signal };
  });

  await step('resume in a NEW process (session/load)', async () => {
    const client2 = newClient({ cwd: WORKDIR });
    await client2.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const load = await attempt(() =>
      client2.request(
        'session/load',
        { sessionId, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    let history;
    if (load.ok) {
      history = await attempt(() => prompt(client2, sessionId, HISTORY_QUESTION));
    }
    await client2.close();
    return {
      load: { ok: load.ok, error: load.error, keys: load.ok ? Object.keys(load.result) : null },
      status: load.ok ? undefined : 'failed',
      historyRestored: history?.ok ? hasHistory(history.result.agentText) : false,
      answer: history?.ok ? answerEvidence(history.result.agentText) : undefined,
      error: history?.ok ? undefined : history?.error,
    };
  });

  await step('session/resume + session/fork', async () => {
    const client3 = newClient({ cwd: WORKDIR });
    await client3.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const resume = await attempt(() =>
      client3.request(
        'session/resume',
        { sessionId, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    // a fork of a closed session failed once with an internal error: the call is
    // retried once, and both answers stay in the report. Only a *refusal* is
    // retried — an answer that carries an error code means that no fork was
    // created. A timeout carries no code: it is ambiguous (the fork may exist),
    // and a second call would leave a second fork behind.
    const forkAttempts = [];
    const forkCall = () =>
      client3.request(
        'session/fork',
        { sessionId, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      );
    let fork = await attempt(forkCall);
    forkAttempts.push({ ok: fork.ok, error: fork.error, code: fork.code });
    if (!fork.ok && fork.code !== undefined) {
      fork = await attempt(forkCall);
      forkAttempts.push({ ok: fork.ok, error: fork.error, code: fork.code });
    }
    // does the fork carry the transcript of the session it was forked from?
    const forkId = fork.ok ? fork.result?.sessionId : null;
    const forkHistory = forkId
      ? await attempt(() => prompt(client3, forkId, HISTORY_QUESTION))
      : { ok: false, error: 'fork failed' };
    // the deterministic evidence: how many records of the source log the log of
    // the fork holds — no model answer can fake this
    const forkLog = forkId ? sessionLogFile(forkId) : null;
    const copied = copiedRecords(sessionLogFile(sessionId), forkLog);
    await client3.close();
    return {
      resume: {
        ok: resume.ok,
        error: resume.error,
        keys: resume.ok ? Object.keys(resume.result) : null,
      },
      fork: { ok: fork.ok, error: fork.error, keys: fork.ok ? Object.keys(fork.result) : null },
      forkAttempts,
      status: fork.ok ? undefined : 'failed',
      forkId,
      forkCarriesHistory: forkHistory.ok ? hasHistory(forkHistory.result.agentText) : false,
      forkHistoryAnswer: forkHistory.ok ? answerEvidence(forkHistory.result.agentText) : undefined,
      error: forkHistory.ok ? undefined : forkHistory.error,
      sourceRecordsInFork: copied,
    };
  });

  await step('cross-process attach (process B on a session of process A)', async () => {
    const clientA = newClient({ cwd: WORKDIR });
    await clientA.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await newSession(clientA);
    const idA = created.ok ? created.result?.sessionId : null;
    if (!idA) {
      await clientA.close();
      return { created };
    }
    const clientB = newClient({ cwd: WORKDIR });
    await clientB.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const activate = await attempt(() =>
      clientB.request('session/activate', { sessionId: idA }, { timeoutMs: 30000 }),
    );
    // A session of another process is only in the store once it has content:
    // the load of a fresh session fails with "Resource not found". That is
    // measured first — it is what the second process sees before the session
    // has a turn.
    const loadBeforeTurn = await attempt(() =>
      clientB.request(
        'session/load',
        { sessionId: idA, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    // the owner gives the session a turn: after that the session is persisted
    const warmup = await attempt(() => prompt(clientA, idA, 'Reply with exactly: OWNER'));
    const load = await attempt(() =>
      clientB.request(
        'session/load',
        { sessionId: idA, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    const promptB = load.ok
      ? await attempt(() => prompt(clientB, idA, 'Reply with exactly: ATTACHED'))
      : { ok: false, error: 'load failed' };
    const promptA = await attempt(() =>
      prompt(clientA, idA, 'Reply with exactly: OWNER-STILL-ALIVE'),
    );
    await clientB.close();
    await clientA.close();
    // the question of the experiment is whether a second process can drive the
    // session of the first one: both turns have to end with the answer that
    // was asked for, not merely to resolve
    const verdictB = promptB.ok ? turnVerdict(promptB.result, 'ATTACHED') : null;
    const verdictA = promptA.ok ? turnVerdict(promptA.result, 'OWNER-STILL-ALIVE') : null;
    const attached =
      load.ok &&
      Boolean(verdictB?.ended && verdictB?.markerMatched) &&
      Boolean(verdictA?.ended && verdictA?.markerMatched);
    return {
      sessionIdA: idA,
      activate,
      // the state of the session before it had a turn: the store does not know
      // it yet
      loadBeforeTurn: { ok: loadBeforeTurn.ok, error: loadBeforeTurn.error },
      warmup: warmup.ok ? { ok: true, answer: answerEvidence(warmup.result.agentText) } : warmup,
      load: { ok: load.ok, error: load.error },
      promptB: promptB.ok
        ? {
            ok: true,
            answer: answerEvidence(promptB.result.agentText),
            stopReason: promptB.result.stopReason,
            markerMatched: verdictB.markerMatched,
          }
        : promptB,
      promptA: promptA.ok
        ? {
            ok: true,
            answer: answerEvidence(promptA.result.agentText),
            stopReason: promptA.result.stopReason,
            markerMatched: verdictA.markerMatched,
          }
        : promptA,
      attached,
      status: attached ? undefined : 'failed',
      note: attached
        ? undefined
        : load.ok
          ? 'the second process could not drive the session'
          : 'the second process could not load the session of the first one',
    };
  });

  await step('cross-process concurrent prompts (two processes, one session)', async () => {
    // The sequential test above proves that two processes can drive one session.
    // This one asks the harder question: can they do it at the same time?
    const clientA = newClient({ cwd: WORKDIR });
    await clientA.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = await newSession(clientA);
    const id = created.ok ? created.result?.sessionId : null;
    if (!id) {
      await clientA.close();
      return { created };
    }
    const clientB = newClient({ cwd: WORKDIR });
    await clientB.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    // the session needs a turn before the store holds it — without one the
    // second process does not find it at all (see the attach step above)
    const warmup = await attempt(() => prompt(clientA, id, 'Reply with exactly: OWNER'));
    const load = await attempt(() =>
      clientB.request(
        'session/load',
        { sessionId: id, cwd: WORKDIR, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    // both prompts are in flight before either is awaited
    const promiseA = load.ok
      ? attempt(() => prompt(clientA, id, 'Reply with exactly: CONCURRENT-A'))
      : Promise.resolve({ ok: false, error: 'load failed' });
    const promiseB = load.ok
      ? attempt(() => prompt(clientB, id, 'Reply with exactly: CONCURRENT-B'))
      : Promise.resolve({ ok: false, error: 'load failed' });
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    await clientB.close();
    await clientA.close();
    const summarize = (r) =>
      r.ok
        ? {
            ok: true,
            answer: answerEvidence(r.result.agentText),
            stopReason: r.result.stopReason,
            turnId: r.result.turn?.turnId,
          }
        : r;
    // the expected outcome: one prompt is served, the other one is refused
    // because the session has an active turn
    const accepted = [resultA, resultB].filter((r) => r.ok);
    const refused = [resultA, resultB].filter((r) => !r.ok);
    const refusedByActiveTurn =
      refused.length === 1 && /active Turn/i.test(String(refused[0].error ?? ''));
    // the prompt that won the turn has to end with the answer that was asked
    // for: a served turn that never ended is not a served turn
    const served =
      accepted.length === 1
        ? turnVerdict(accepted[0].result, 'CONCURRENT')
        : { ended: false, markerMatched: false };
    const asExpected = accepted.length === 1 && refusedByActiveTurn && served.ended;
    const outcome =
      accepted.length === 2
        ? 'both prompts were served'
        : accepted.length === 1
          ? 'one prompt was served, the other one was refused'
          : 'no prompt was served';
    return {
      sessionId: id,
      warmup: warmup.ok ? { ok: true, answer: answerEvidence(warmup.result.agentText) } : warmup,
      load: { ok: load.ok, error: load.error },
      promptA: summarize(resultA),
      promptB: summarize(resultB),
      bothAnswered: resultA.ok && resultB.ok,
      // the same turn id in both answers would mean the turns were merged
      sameTurn:
        resultA.ok && resultB.ok
          ? resultA.result.turn?.turnId === resultB.result.turn?.turnId
          : null,
      outcome,
      refusedByActiveTurn,
      status: asExpected ? undefined : 'inconclusive',
      note: asExpected ? undefined : `the concurrency did not end as expected: ${outcome}`,
    };
  });

  await step('permission flow (Ask mode, fresh process)', async () => {
    // The permission mode is process scoped, but `session/set_config_option` needs a
    // session id — so the mode can only be set once the session exists.
    //
    // The probe directory is created before the client connects: the permission
    // handler needs the boundary of the experiment, and the write of the model
    // has to be inside it — a write outside of the boundary would be refused by
    // the handler and the experiment would measure the refusal, not the flow.
    // The target lives in a fresh temporary directory: the spike never writes
    // over a file of the machine.
    const probeRoot = resolve(homedir(), '.cache/10x-chat-tmp');
    mkdirSync(probeRoot, { recursive: true });
    const probeDir = mkdtempSync(resolve(probeRoot, 'acp-spike-perm-'));
    const target = resolve(probeDir, 'probe.txt');
    const {
      client: cp,
      permissionRequests: requests,
      refusedOutsideBoundary,
    } = await connect(WORKDIR, () => [WORKDIR, probeDir]);
    try {
      // One attempt: a session of its own, the mode set on it and the prompt
      // asked. Every attempt is a fresh session — a model that narrates the
      // write leaves a turn that the next prompt of the same session answers
      // with the same narration.
      const attemptOnce = async () => {
        const created = await cp.request('session/new', { cwd: WORKDIR, mcpServers: [] });
        const id = created?.sessionId;
        const modeBefore = created?.configOptions?.find(
          (o) => o.id === 'permissionMode',
        )?.currentValue;
        const setMode = await attempt(() =>
          cp.request('session/set_config_option', {
            sessionId: id,
            configId: 'permissionMode',
            value: 'default',
          }),
        );
        if (!setMode.ok) {
          // without the mode the write would be a different experiment: the
          // model would write without asking
          return { modeBefore, setMode: { ok: false, error: setMode.error }, r: null };
        }
        const first = requests.length;
        const asked = await attempt(() =>
          prompt(
            cp,
            id,
            `Use the write tool (not a shell command) to write the file ${target} with the content PROBE. A tool call is required: answering in words does not finish this task — make the tool call, and answer only after the tool has run.`,
          ),
        );
        return {
          modeBefore,
          setMode: { ok: true },
          r: asked.ok ? asked.result : null,
          error: asked.ok ? undefined : { error: asked.error, code: asked.code },
          own: requests.slice(first),
        };
      };

      // The model sometimes narrates the write and ends the turn without
      // calling the tool. That is a turn of the model, not a fault of the
      // flow: the experiment is about the question the runtime asks, so the
      // prompt is asked again in a fresh session before the step is called a
      // failure. Only a refusal of the runtime (an error with a code) or a
      // turn without the call is retried — a lost answer is never retried.
      let last = null;
      let attempts = 0;
      for (let round = 0; round < 3; round++) {
        attempts = round + 1;
        last = await attemptOnce();
        const own = last.own ?? [];
        if (own.length > 0 || existsSync(target)) break;
        // the probe file of a failed attempt must not satisfy the next one
        rmSync(target, { force: true });
        // a failure without a code is ambiguous (a timeout, a lost answer) and
        // is never retried; a refusal of the runtime carries a code and is
        // asked again in a fresh session
        if (last.error && !last.error.code) break;
      }
      const own = last.own ?? [];
      // the write has to be the one that was asked about: a request for another
      // tool and a file with another content are not the experiment
      const askedForWrite = own.some((p) =>
        /write/i.test(String(p?.toolCall?.title ?? p?.toolCall?.kind ?? '')),
      );
      const contentOk = existsSync(target) && readFileSync(target, 'utf8').trim() === 'PROBE';
      if (!last.setMode.ok) {
        return {
          modeBefore: last.modeBefore,
          setMode: last.setMode,
          status: 'failed',
          note: 'the permission mode could not be set — the write was not attempted',
        };
      }
      return {
        modeBefore: last.modeBefore,
        setMode: last.setMode,
        permissionAsked: own.length > 0,
        askedForWrite,
        // how many sessions the flow needed: a model that only narrates the
        // write is a fact of the model, not of the protocol
        attempts,
        permissionRequests: own.map((p) => ({
          tool: p?.toolCall?.title ?? p?.toolCall?.kind,
          // the kind of the call is what the boundary decides on
          kind: p?.toolCall?.kind,
          kinds: p?.options?.map((o) => o.kind),
        })),
        // the calls the handler refused: the boundary of the experiment is a
        // property of the run, so the report has to show it was enforced
        refusedOutsideBoundary,
        // the refusal of the runtime, when the turn was refused
        error: last.error?.error,
        errorCode: last.error?.code,
        stopReason: last.r?.stopReason,
        answer: answerEvidence(last.r?.agentText),
        updateKinds: last.r?.updateKinds,
        fileCreated: existsSync(target),
        fileContentMatches: contentOk,
        // the experiment is only settled when the mode was established, the agent
        // really asked about the write, the turn ended and the file holds what
        // was asked for
        status:
          last.setMode.ok && askedForWrite && contentOk && last.r?.stopReason === 'end_turn'
            ? undefined
            : 'failed',
      };
    } finally {
      // the probe file is of no use after the experiment — and the process of
      // the experiment must not stay behind when the experiment fails
      rmSync(probeDir, { recursive: true, force: true });
      await cp.close();
    }
  });

  await step('TUI session (live, manually launched) — attach?', async () => {
    if (!TUI_SESSION_ID) return { skipped: 'SPIKE_TUI_SESSION_ID not set' };
    // the log of the session: the explicit path wins, otherwise the store of the
    // runtime is searched for the id of the session
    const tuiLog = TUI_SESSION_FILE || sessionLogFile(TUI_SESSION_ID);
    const before = tuiLog ? fileStamp(tuiLog) : null;
    // session/load refuses a cwd that differs from the persisted workspace
    const tuiCwd = process.env.SPIKE_TUI_SESSION_CWD || WORKDIR;
    const clientT = newClient({ cwd: tuiCwd });
    await clientT.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const activate = await attempt(() =>
      clientT.request('session/activate', { sessionId: TUI_SESSION_ID }, { timeoutMs: 30000 }),
    );
    const load = await attempt(() =>
      clientT.request(
        'session/load',
        { sessionId: TUI_SESSION_ID, cwd: tuiCwd, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    // a fork proves that the history of a TUI session is readable and controllable
    // through ACP — without writing anything into the live TUI session
    const fork = await attempt(() =>
      clientT.request(
        'session/fork',
        { sessionId: TUI_SESSION_ID, cwd: tuiCwd, mcpServers: [] },
        { timeoutMs: 90000 },
      ),
    );
    let forked;
    let forkStats = null;
    let sourceRecordsInFork = null;
    let forkAnswerQuotedSource = null;
    let sourceMarker = null;
    if (fork.ok) {
      const forkId = fork.result?.sessionId;
      // The marker of the check is the source transcript itself: the fork is
      // asked to quote its first answer, and the answer is compared with the
      // text of the source log — locally, so that nothing of another
      // conversation is published.
      const marker = firstAssistantText(tuiLog);
      // the fork is asked about the history of the session it came from — the live
      // TUI session itself is never prompted (that would write into its log)
      forked = {
        forkId,
        ...(await attempt(() =>
          prompt(clientT, forkId, 'Quote your first answer in this conversation exactly.'),
        )),
      };
      // the fork has its own log: it holds the records of the source session
      const forkLog = sessionLogFile(forkId);
      forkStats = forkLog ? logStats(forkLog) : null;
      sourceRecordsInFork = copiedRecords(tuiLog, forkLog);
      if (marker && forked.ok) {
        const needle = comparable(marker).slice(0, 24);
        forkAnswerQuotedSource = needle
          ? comparable(forked.result?.agentText).includes(needle)
          : null;
        sourceMarker = {
          chars: marker.length,
          sha256: createHash('sha256').update(marker).digest('hex').slice(0, 12),
        };
      }
    }
    const after = tuiLog ? fileStamp(tuiLog) : null;
    await clientT.close();
    // The status follows the operations: `ok` means that the session of the live
    // TUI was really loaded and forked. A step that reports a success it did not
    // measure would be a lie.
    let status;
    let note;
    if (!load.ok) {
      status = 'inconclusive';
      note = 'the session of the TUI could not be loaded — nothing was measured';
    } else if (!fork.ok) {
      status = 'failed';
      note = 'the fork of the TUI session failed — the transcript was not measured';
    } else if (!tuiLog) {
      status = 'inconclusive';
      note = 'the log of the TUI session was not found — the records were not compared';
    } else if (!sourceRecordsInFork || sourceRecordsInFork.total === 0) {
      // an empty transcript proves nothing: there was nothing to carry
      status = 'inconclusive';
      note = 'the transcript of the TUI session is empty — nothing was compared';
    } else if (sourceRecordsInFork.matched !== sourceRecordsInFork.total) {
      // the fork does not hold every record of the source: the transcript was
      // not carried over
      status = 'failed';
      note = 'the fork does not hold every record of the TUI session';
    }
    return {
      tuiSessionId: TUI_SESSION_ID,
      tuiCwd,
      activate,
      load: { ok: load.ok, error: load.error, keys: load.ok ? Object.keys(load.result) : null },
      fork: { ok: fork.ok, error: fork.error },
      status,
      note,
      // the answer is not published: it contains the text of another conversation
      forkAnswerQuotedSource,
      sourceMarker,
      // the deterministic evidence that the fork carries the transcript
      sourceRecordsInFork,
      forkLog: forkStats,
      liveSessionLog: tuiLog ? logStats(tuiLog) : null,
      liveSessionFileBefore: before,
      liveSessionFileAfter: after,
      liveSessionMutated:
        before && after
          ? before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.hash !== after.hash
          : null,
    };
  });

  await step('TUI launch from a pty (manually launched)', async () => {
    // `script` is not installed on this machine; python3 has the pty module.
    const probe = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' });
    if (probe.status !== 0) return { skipped: 'no pty available' };
    const before = new Set(sessionStoreDirs());
    const tui = spawnSync('python3', [resolve(HERE, 'tui.py')], {
      cwd: WORKDIR,
      timeout: 150000,
      encoding: 'utf8',
      env: { ...process.env, TUI_TEXT: 'Reply with exactly: TUI-PONG', TUI_SECONDS: '90' },
    });
    // the runtime persists the session of the TUI a moment after the process
    // is gone: the step waits for it, otherwise a run that worked looks like a
    // run that left nothing behind
    const after = await waitForNewSession(before, 15000);
    const tuiSessionId = after.map(sessionIdFromDir).find(Boolean) ?? null;
    // the raw output of the terminal is not published: it can carry the text of
    // the screen, and the report is public. The composer is the only thing the
    // experiment needs to know about.
    const output = stripAnsi(tui.stdout ?? '');
    // the raw output of the terminal is not logged: it can hold the text of the
    // conversation of the TUI. What is kept is what can be checked without it.
    // The answer of the TUI is in the log of the session it persisted: that is
    // the proof that the prompt was really answered — the launch and the
    // session alone would prove nothing.
    const tuiLog = tuiSessionId ? sessionLogFile(tuiSessionId) : null;
    const answered = hasAssistantText(tuiLog, 'TUI-PONG');
    const composerVisible = /Ask Mcode to do anything/.test(output);
    const cleanExit = tui.status === 0 && !tui.error;
    // the experiment is settled only when the TUI rendered, answered and left a
    // session behind — a run that only started the TUI measured nothing
    const settled = Boolean(tuiSessionId) && answered && composerVisible && cleanExit;
    return {
      tuiExit: tui.status,
      newSessionDirs: after.length,
      tuiSessionId,
      composerVisible,
      // the answer of the TUI is not published: only the fact that it is there
      tuiAnswered: answered,
      status: settled ? undefined : tuiSessionId ? 'failed' : 'inconclusive',
      note: settled
        ? undefined
        : tuiSessionId
          ? 'the TUI did not answer the prompt (or did not end cleanly)'
          : 'the TUI left no persisted session',
    };
  });

  report.meta.finishedAt = new Date().toISOString();
  // a violation of the protocol belongs in the report: a dropped message would
  // look like a missing answer. Every client of the run is asked — a violation
  // in a second process is a violation of the run.
  report.meta.protocolErrors = clients.flatMap((c, index) =>
    c.protocolErrors().map((e) => ({ ...e, client: index })),
  );
  writeReport();
  log('report written to', RESULTS);
  // the process would otherwise stay alive on a handle of a closed child
  // a failed experiment is a failure of the run: the exit code says so, while
  // `inconclusive` and `skipped` stay what they are — not a failure
  const failed = report.steps.filter((s) => s.status === 'failed');
  if (failed.length) log('failed steps:', failed.map((s) => s.name).join(', '));
  process.exit(failed.length ? 1 : 0);
}

/**
 * The session store of the runtime: every session is a directory named
 * `<time>-session_<base64 of the session id>`.
 *
 * The name of the directory is matched on the `session_` part — a directory
 * that starts with a time stamp is not a session of the store.
 */
function sessionStoreDirs() {
  const root = resolve(process.env.HOME, '.minimax/v2/sessions');
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (!e.isDirectory()) continue;
      if (e.name.includes('session_')) out.push(p);
      else walk(p);
    }
  };
  walk(root);
  return out;
}

/**
 * The sessions of the store that were not there before, waiting for the
 * runtime to persist them: the directory of a session can appear a moment
 * after the process that wrote it is gone.
 */
async function waitForNewSession(before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = sessionStoreDirs().filter((d) => !before.has(d));
    if (after.length) return after;
    if (Date.now() >= deadline) return after;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The session id of a store directory, or null when the name carries none. */
function sessionIdFromDir(dir) {
  const name = dir.split('/').pop() ?? '';
  const encoded = name.split('session_').pop();
  if (!encoded) return null;
  try {
    const id = Buffer.from(encoded, 'base64').toString('utf8');
    return /^mvs_[0-9a-f]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The log file of a session in the store, or null when the session has none. */
function sessionLogFile(sessionId) {
  for (const dir of sessionStoreDirs()) {
    if (sessionIdFromDir(dir) !== sessionId) continue;
    const file = resolve(dir, 'messages.jsonl');
    if (existsSync(file)) return file;
  }
  return null;
}

/** The number of records and the size of a session log. */
function logStats(file) {
  try {
    const content = readFileSync(file, 'utf8');
    const records = content.split('\n').filter((line) => line.trim()).length;
    return { records, bytes: Buffer.byteLength(content) };
  } catch {
    return null;
  }
}

/** The ids of the records of a session log. */
function logRecordIds(file) {
  const ids = new Set();
  if (!file) return ids;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return ids;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.message_id) ids.add(record.message_id);
    } catch {
      // a line that is not a record is not evidence
    }
  }
  return ids;
}

/**
 * How many records of the source log the log of the fork holds.
 *
 * This is the deterministic evidence that a fork carries the transcript of its
 * source: no answer of a model can fake it, and nothing of the transcript is
 * published — only the counts.
 */
function copiedRecords(sourceFile, forkFile) {
  if (!sourceFile || !forkFile) return null;
  const source = logRecordIds(sourceFile);
  const fork = logRecordIds(forkFile);
  let matched = 0;
  for (const id of source) if (fork.has(id)) matched += 1;
  return { matched, total: source.size };
}

/** The text of a message, whatever shape its content has. */
function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** The text of the first answer of the assistant of a session log, or null. */
function firstAssistantText(file) {
  if (!file) return null;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.message?.role !== 'assistant') continue;
    const text = textOfMessage(record.message).trim();
    if (text) return text;
  }
  return null;
}

/**
 * Whether an answer of the assistant of a session log holds the marker.
 *
 * Only the messages of the assistant count: the prompt of the user holds the
 * marker too, and a match in the prompt proves nothing.
 */
function hasAssistantText(file, needle) {
  if (!file || !needle) return false;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.message?.role !== 'assistant') continue;
    if (textOfMessage(record.message).includes(needle)) return true;
  }
  return false;
}

/** The comparable form of a text: only its letters and digits, in lower case. */
const comparable = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

main().catch((err) => {
  report.meta.error = String(err?.message ?? err);
  writeReport();
  console.error(err);
  process.exit(1);
});
