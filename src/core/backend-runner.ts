import chalk from 'chalk';
import { type AiBackend, BackendError, type BackendRequest } from '../backend/contract.js';
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
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };

  const startTime = Date.now();
  const outcome = await backend.ask(request);
  const durationMs = Date.now() - startTime;

  if (!outcome.ok) {
    await updateSession(session.id, {
      status: outcome.failure.kind === 'timeout' ? 'timeout' : 'failed',
      durationMs,
    });
    throw new BackendError(outcome.failure);
  }

  const response = outcome.value;
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
