import chalk from 'chalk';
import type { BrowserProxy } from '../browser/proxy.js';
import { loadConfig, resolveEffectiveProxy } from '../config.js';
import { getApiTransport } from '../providers/api/registry.js';
import { getProvider } from '../providers/index.js';
import { redactSecretValues } from '../secrets.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import { createApiHttpClient } from '../transport/http.js';
import type { ApiHttpClient, ApiTransport, ChatOptions, TransportName } from '../types.js';
import { buildBundle } from './bundle.js';
import { getProviderApiKey } from './credentials.js';
import { ApiRequestError, apiFailureKind, MissingCredentialError, reclassify } from './failures.js';
import { chatModel } from './model.js';
import type { ChatResult } from './orchestrator.js';
import { chatTimeoutMs } from './timeout.js';

export interface ApiChatDeps {
  /** The transport of the run — the one of the provider by default. */
  transport?: ApiTransport;
  /** The HTTP client of the run — a real one by default. */
  client?: ApiHttpClient;
  /** The resolver of the proxy of the run — the effective one by default. */
  resolveProxy?: () => Promise<BrowserProxy | null>;
}

/**
 * The transport of a chat run.
 *
 * The browser is the default: an existing run must keep working the way it
 * worked before the API transport existed.
 */
export function resolveTransport(options: ChatOptions): TransportName {
  return options.transport ?? 'browser';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute a chat interaction through the HTTP API of a provider.
 *
 * The run reuses the session, the bundle and the response of the browser run,
 * but it never starts a browser: there is no login check, no page and no
 * profile — the credential of the provider is the API key of the secrets store.
 */
export async function runApiChat(
  options: ChatOptions,
  deps: ApiChatDeps = {},
): Promise<ChatResult> {
  const config = await loadConfig();
  const providerName = options.provider ?? config.defaultProvider;
  const provider = getProvider(providerName);

  const transport = deps.transport ?? getApiTransport(providerName);
  if (!transport) {
    throw new Error(
      `Provider '${providerName}' has no API transport. ` +
        'Use --transport browser, or a provider that has one.',
    );
  }

  const timeoutMs = chatTimeoutMs(
    options.timeoutMs,
    config.defaultTimeoutMs,
    provider.config.defaultTimeoutMs,
  );

  const model = chatModel(options.model, config.defaultModel, provider.config.defaultModel);
  if (model && provider.config.models && !provider.config.models.includes(model)) {
    throw new Error(
      `Unknown model "${model}" for ${provider.config.displayName}. ` +
        `Expected one of: ${provider.config.models.join(', ')}.`,
    );
  }

  if (options.providers && options.providers.length > 0) {
    throw new Error(
      `The API transport of ${provider.config.displayName} does not support --all (transports are never mixed).`,
    );
  }

  // A capability that the transport does not have is rejected, not ignored.
  if (options.attach && options.attach.length > 0 && !transport.capabilities.attachments) {
    throw new Error(
      `The API transport of ${provider.config.displayName} does not support attachments.`,
    );
  }

  // The browser flags would be ignored by an API run — a flag that does
  // nothing is a lie about what the run does.
  if (options.headed || options.headless || options.profile || options.isolatedProfile) {
    throw new Error(
      `The API transport of ${provider.config.displayName} does not use a browser — ` +
        'the browser flags (--headed, --headless, --profile, --isolated-profile) do not apply.',
    );
  }

  const apiKey = await getProviderApiKey(providerName);
  if (!apiKey) {
    throw new MissingCredentialError(
      `No API key is configured for ${provider.config.displayName}. ` +
        `Create a secret and reference it as "providerKeys.${providerName}" in the config file ` +
        '(see docs/secrets.md).',
    );
  }

  // Build the bundle
  const bundle = await buildBundle({
    prompt: options.prompt,
    files: options.file,
  });

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, bundle);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName} (api)`));

  // The session is running from here on: a run that dies now must not leave
  // a session that claims to be pending.
  await updateSession(session.id, { status: 'running' });

  const startTime = Date.now();

  try {
    // The client is built inside the try: a failure of the setup (a proxy
    // that cannot be resolved) has to end the session as failed too.
    const client =
      deps.client ?? createApiHttpClient(await (deps.resolveProxy ?? resolveEffectiveProxy)());

    const captured = await transport.send({
      prompt: bundle,
      model,
      apiKey,
      timeoutMs,
      client,
    });

    const durationMs = Date.now() - startTime;
    await saveResponse(session.id, captured.text);
    await updateSession(session.id, {
      status: captured.truncated ? 'timeout' : 'completed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      response: captured.text,
      truncated: captured.truncated,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    // The key must not reach an error message: the body of an error answer of
    // a provider can echo it back.
    const text = redactSecretValues(message(error), [apiKey]);
    const isTimeout = text.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });

    const kind = error instanceof ApiRequestError ? apiFailureKind(error.status) : undefined;
    const full = `${text} (provider=${providerName} transport=api)`;
    if (kind) throw reclassify(kind, full);
    throw new Error(full);
  }
}
