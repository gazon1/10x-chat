import chalk from 'chalk';
import {
  type AiBackend,
  BackendError,
  type BackendFailure,
  type BackendOutcome,
  type BackendRequest,
  type BackendResponse,
} from '../backend/contract.js';
import { loadConfig } from '../config.js';
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
  const provider = options.provider ?? config.defaultProvider;

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

  const attachments =
    options.attach && options.attach.length > 0 ? await resolveAttachPaths(options.attach) : [];

  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;

  const bundle = await buildBundle({ prompt: options.prompt, files: options.file });
  const session = await createSession(provider, options.prompt, options.model);
  await saveBundle(session.id, bundle);
  await updateSession(session.id, { status: 'running' });

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Backend: ${backend.name}`));

  const request: BackendRequest = {
    requestId: session.id,
    prompt: bundle,
    ...(model ? { model } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    // The timeout of a chat: the flag of the command, then the config file.
    // The default of a provider does not apply — a backend has its own.
    ...(timeoutMs ? { timeoutMs } : {}),
    // A streaming backend writes its answer while it is generated — the
    // same convention the browser providers use.
    onChunk: (chunk: string) => {
      process.stdout.write(chalk.dim(chunk));
    },
  };

  const startTime = Date.now();
  let outcome: BackendOutcome<BackendResponse>;
  try {
    outcome = await backend.ask(request);
  } catch (error) {
    // A backend that throws is a backend that failed: the session must not
    // stay 'running' forever.
    await updateSession(session.id, { status: 'failed', durationMs: Date.now() - startTime });
    throw error;
  }
  const durationMs = Date.now() - startTime;

  if (!outcome.ok) {
    await updateSession(session.id, {
      status: outcome.failure.kind === 'timeout' ? 'timeout' : 'failed',
      durationMs,
    });
    throw new BackendError(outcome.failure);
  }

  const response = outcome.value;
  // A success without an answer is not an answer: the contract says a
  // failure is never an empty value — and an empty value is not a success.
  const invalid = invalidOutput(response, request.requestId);
  if (invalid) {
    await updateSession(session.id, { status: 'failed', durationMs });
    throw new BackendError(invalid);
  }
  await saveResponse(session.id, response.text);
  await updateSession(session.id, {
    status: response.truncated ? 'timeout' : 'completed',
    durationMs,
  });

  return {
    sessionId: session.id,
    provider,
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
 */
function invalidOutput(response: BackendResponse, requestId: string): BackendFailure | undefined {
  if (response.requestId !== requestId) {
    return {
      kind: 'invalid_output',
      message: `The backend answered the request '${response.requestId}' instead of '${requestId}'.`,
      submission: response.submission,
    };
  }
  const hasImages = (response.images?.length ?? 0) > 0;
  if (response.text.trim() === '' && !hasImages) {
    return {
      kind: 'invalid_output',
      message: 'The backend answered with an empty response.',
      submission: response.submission,
    };
  }
  return undefined;
}
