import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  type AiBackend,
  BackendError,
  type BackendFailure,
  type BackendFailureKind,
  type BackendOutcome,
  type BackendRequest,
  type BackendResponse,
  type BackendSubmission,
  SUBMISSIONS_OF_FAILURE,
} from '../backend/contract.js';
import { providerOfBackend } from '../backend/registry.js';
import { loadConfig } from '../config.js';
import { getSessionDir } from '../paths.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { ChatOptions } from '../types.js';
import { buildBundle } from './bundle.js';
import { resolveAttachPaths } from './files.js';
import type { ChatResult } from './orchestrator.js';

/**
 * Run a chat through the backend contract.
 *
 * This is the application side of the seam: no page, no selector, no session
 * of a browser — only the request and the answer of the backend.
 *
 * The conversation of a backend run is not reused yet: the contract carries
 * the conversation id, the reuse itself comes with the migration of the
 * providers.
 */
export async function runBackendChat(
  options: ChatOptions,
  backend: AiBackend,
): Promise<ChatResult> {
  const config = await loadConfig();
  // The provider of the run: the one of the command, the one the backend
  // drives, the default of the config file — never another one.
  const provider = options.provider ?? providerOfBackend(backend.name) ?? config.defaultProvider;

  // A capability the backend does not have is rejected, never ignored — the
  // same rule the API transport follows.
  if (options.attach && options.attach.length > 0 && !backend.capabilities.attachments) {
    throw new Error(`The backend '${backend.name}' does not support attachments.`);
  }
  const model = options.model ?? config.defaultModel;
  if (model && !backend.capabilities.modelSelection) {
    throw new Error(`The backend '${backend.name}' does not support model selection.`);
  }
  // The browser flags would be ignored by a backend run — a flag that does
  // nothing is a lie about what the run does.
  if (options.headed || options.headless || options.profile || options.isolatedProfile) {
    throw new Error(
      `The backend '${backend.name}' does not use a browser — ` +
        'the browser flags (--headed, --headless, --profile, --isolated-profile) do not apply.',
    );
  }
  // A backend manages no conversation and is no transport: the options that
  // ask for one are refused, not ignored.
  if (options.newChat) {
    throw new Error(
      `The backend '${backend.name}' does not manage conversations — the option 'newChat' does not apply.`,
    );
  }
  if (options.transport) {
    throw new Error(
      `The backend '${backend.name}' is not a transport — the option 'transport' does not apply.`,
    );
  }

  const attachments =
    options.attach && options.attach.length > 0 ? await resolveAttachPaths(options.attach) : [];

  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;

  const bundle = await buildBundle({ prompt: options.prompt, files: options.file });
  // The backend answers the run — the session records it, so the history
  // does not claim that a provider answered.
  const session = await createSession(provider, options.prompt, model, backend.name);
  try {
    await saveBundle(session.id, bundle);
  } catch (error) {
    // The run never started — the session must not stay 'pending'.
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }

  // The images of the answer are saved by the backend itself: the downloader
  // of the browser path needs a page with the cookies. The directory is the
  // one of the session, as it is without --save-images.
  const saveDir = options.saveImages ?? path.join(getSessionDir(session.id), 'images');
  try {
    await mkdir(saveDir, { recursive: true });
  } catch (error) {
    // The run never started — the session must not stay 'running'.
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }
  await updateSession(session.id, { status: 'running' });

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Backend: ${backend.name}`));

  // The output a streaming backend produces is kept: an answer that arrives
  // before the backend breaks belongs to the session.
  let streamed = '';
  const request: BackendRequest = {
    requestId: session.id,
    prompt: bundle,
    ...(model ? { model } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    saveDir,
    // The timeout of a chat: the flag of the command, then the config file.
    // The default of a provider does not apply — a backend has its own.
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    // A streaming backend writes its answer while it is generated — the
    // same convention the browser providers use.
    onChunk: (chunk: string) => {
      streamed += chunk;
      process.stdout.write(chalk.dim(chunk));
    },
  };

  const startTime = Date.now();
  let outcome: BackendOutcome<BackendResponse>;
  try {
    outcome = await backend.ask(request);
  } catch (error) {
    // The output that arrived before the crash is saved — the same handling
    // as the partial output of a failure.
    if (streamed) {
      try {
        await saveResponse(session.id, streamed);
      } catch {
        // The output cannot be stored — the failure of the run is reported
        // anyway.
      }
    }
    // A backend that throws is a backend that failed: the session must not
    // stay 'running' forever.
    await updateSession(session.id, { status: 'failed', durationMs: Date.now() - startTime });
    throw error;
  }
  const durationMs = Date.now() - startTime;

  if (!outcome || typeof outcome !== 'object') {
    await updateSession(session.id, { status: 'failed', durationMs });
    throw new BackendError({
      kind: 'invalid_output',
      message: 'The backend answered without an outcome.',
      submission: 'unknown',
    });
  }

  if (!outcome.ok) {
    // A backend is an implementation of another program: its failure is
    // checked, not trusted. A malformed failure is a failure too.
    const failure = validFailure(outcome.failure);
    // The session leaves 'running' before anything else can fail: a stored
    // output that cannot be written must not keep the session alive.
    await updateSession(session.id, {
      status: failure.kind === 'timeout' ? 'timeout' : 'failed',
      durationMs,
    });
    // The answer that arrived before the failure belongs to the session —
    // otherwise the partial output of a timeout is lost. A backend that
    // streams its answer reports it in the chunks it wrote.
    const partial = failure.partialText ?? (streamed || undefined);
    if (partial) {
      try {
        await saveResponse(session.id, partial);
      } catch {
        // The output cannot be stored — the failure of the run is reported
        // anyway.
      }
    }
    throw new BackendError(failure);
  }

  const response = outcome.value;
  // A success without an answer is not an answer: the contract says a
  // failure is never an empty value — and an empty value is not a success.
  const invalid = invalidOutput(response, request.requestId, backend.capabilities.imageOutput);
  if (invalid) {
    await updateSession(session.id, { status: 'failed', durationMs });
    throw new BackendError(invalid);
  }
  try {
    await saveResponse(session.id, response.text);
  } catch (error) {
    // The answer cannot be stored — the session must not stay 'running'.
    await updateSession(session.id, { status: 'failed', durationMs });
    throw error;
  }
  await updateSession(session.id, {
    status: response.truncated ? 'timeout' : 'completed',
    durationMs,
  });

  return {
    sessionId: session.id,
    provider,
    backend: backend.name,
    response: response.text,
    truncated: response.truncated,
    durationMs,
    ...(response.conversationId ? { conversationId: response.conversationId } : {}),
    ...(response.images && response.images.length > 0 ? { images: response.images } : {}),
  };
}

/**
 * The failure of a successful response that cannot be used.
 *
 * An empty answer is an answer that did not arrive, and an answer of another
 * request belongs to another request — both are `invalid_output`.
 *
 * A backend is an implementation of another program: its answer is checked,
 * not trusted. The check never throws — a malformed answer is a failure, not
 * a crash of the run.
 */
function invalidOutput(
  response: BackendResponse,
  requestId: string,
  imageOutput: boolean,
): BackendFailure | undefined {
  if (!response || typeof response !== 'object') {
    return {
      kind: 'invalid_output',
      message: 'The backend answered without a response.',
      submission: 'unknown',
    };
  }
  const submission = submissionOf(response.submission);
  if (typeof response.text !== 'string') {
    return {
      kind: 'invalid_output',
      message: 'The backend answered without text.',
      submission,
    };
  }
  if (typeof response.truncated !== 'boolean') {
    return {
      kind: 'invalid_output',
      message: 'The backend answered without the state of the answer.',
      submission,
    };
  }
  // An answer means the request reached the model — a backend that claims
  // otherwise contradicts itself.
  if (submission !== 'submitted') {
    return {
      kind: 'invalid_output',
      message: `The backend answered with the submission state '${submission}'.`,
      submission,
    };
  }
  if (response.requestId !== requestId) {
    return {
      kind: 'invalid_output',
      message: `The backend answered the request '${response.requestId}' instead of '${requestId}'.`,
      submission,
    };
  }
  // The images of an answer are used by the caller: a malformed one is a
  // malformed answer.
  if (response.images !== undefined) {
    const malformed =
      !Array.isArray(response.images) ||
      response.images.some(
        (image) => !image || typeof image.url !== 'string' || image.url.trim() === '',
      );
    if (malformed) {
      return {
        kind: 'invalid_output',
        message: 'The backend answered with malformed images.',
        submission,
      };
    }
    // A backend that cannot produce images must not produce images: the
    // answer contradicts the capability the backend announced.
    if (!imageOutput && response.images.length > 0) {
      return {
        kind: 'invalid_output',
        message: 'The backend answered with images, but it does not support them.',
        submission,
      };
    }
  }
  const hasImages = Array.isArray(response.images) && response.images.length > 0;
  if (response.text.trim() === '' && !hasImages) {
    return {
      kind: 'invalid_output',
      message: 'The backend answered with an empty response.',
      submission,
    };
  }
  return undefined;
}

/**
 * The failure of a backend that could not be trusted.
 *
 * A malformed failure is not a reason to crash the run: it is a failure the
 * application cannot use — `invalid_output` — with the state the backend did
 * answer.
 */
function validFailure(failure: unknown): BackendFailure {
  if (!failure || typeof failure !== 'object') {
    return {
      kind: 'invalid_output',
      message: 'The backend failed without a failure.',
      submission: 'unknown',
    };
  }
  const value = failure as Partial<BackendFailure>;
  const kind = FAILURE_KINDS.includes(value.kind as BackendFailureKind)
    ? (value.kind as BackendFailureKind)
    : 'invalid_output';
  const message =
    typeof value.message === 'string' && value.message !== ''
      ? value.message
      : 'The backend failed without a message.';
  const partialText =
    typeof value.partialText === 'string' && value.partialText !== ''
      ? { partialText: value.partialText }
      : {};
  const submission = submissionOf(value.submission);
  if (!SUBMISSIONS_OF_FAILURE[kind].includes(submission)) {
    // The failure contradicts itself: neither the kind nor the state can be
    // trusted, so the request is treated like one that may have run.
    return {
      kind: 'invalid_output',
      message: `The backend failed with the kind '${kind}' and the state '${submission}', which contradict each other. ${message}`,
      submission: 'unknown',
      ...partialText,
    };
  }
  return { kind, message, submission, ...partialText };
}

/** The kinds of a failure the contract defines. */
const FAILURE_KINDS: readonly BackendFailureKind[] = [
  'busy',
  'unavailable',
  'timeout',
  'invalid_output',
  'cancelled',
  'unknown_submission',
];

/** The submission state of a response — the state it claims, when it is one. */
function submissionOf(submission: unknown): BackendSubmission {
  return submission === 'not_submitted' || submission === 'submitted' || submission === 'unknown'
    ? submission
    : 'unknown';
}
