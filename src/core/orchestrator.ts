import chalk from 'chalk';
import { browserError } from '../browser/diagnostics.js';
import { launchBrowser } from '../browser/index.js';
import { resolveHeadlessMode } from '../browser/mode.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { ChatOptions, GeneratedImage, ProviderName } from '../types.js';
import { type ApiChatDeps, resolveTransport, runApiChat } from './api-orchestrator.js';
import { buildBundle } from './bundle.js';
import {
  clearStoredConversation,
  conversationIdFromUrl,
  getStoredConversation,
  isConversationGone,
  resolveConversationContext,
  type StoredConversation,
  saveStoredConversation,
} from './conversations.js';
import type { FailureKind } from './failures.js';
import { checkProviderSession, failureKind, reclassify } from './failures.js';
import { resolveAttachPaths } from './files.js';
import { downloadImages } from './images.js';
import { chatModel } from './model.js';
import { chatTimeoutMs } from './timeout.js';

/** Providers supported by chat --all (excludes special-purpose providers). */
const CHAT_PROVIDERS: ProviderName[] = [
  'chatgpt',
  'gemini',
  'claude',
  'grok',
  'perplexity',
  'deepseek',
];

export interface ChatResult {
  sessionId: string;
  provider: ProviderName;
  response: string;
  truncated: boolean;
  durationMs: number;
  /** Images generated in the response (with local paths if saved). */
  images?: GeneratedImage[];
  /** The provider conversation id, when the provider exposes one. */
  conversationId?: string;
}

/**
 * Execute a chat interaction with a provider:
 * 1. Build the prompt bundle
 * 2. Launch the browser
 * 3. Attach files (if any)
 * 4. Submit the prompt
 * 5. Capture the response
 * 6. Save session
 *
 * With `--transport api` the prompt goes to the HTTP API of the provider
 * instead: no browser, no login check, the API key of the secrets store.
 */
export async function runChat(options: ChatOptions, deps: ApiChatDeps = {}): Promise<ChatResult> {
  if (resolveTransport(options) === 'api') {
    return runApiChat(options, deps);
  }

  const config = await loadConfig();
  const providerName = options.provider ?? config.defaultProvider;
  const provider = getProvider(providerName);
  const timeoutMs = chatTimeoutMs(
    options.timeoutMs,
    config.defaultTimeoutMs,
    provider.config.defaultTimeoutMs,
  );
  const headless = resolveHeadlessMode(
    provider.config,
    config.headless,
    options.headed === true,
    options.headless === true,
  );

  // Build the bundle
  const bundle = await buildBundle({
    prompt: options.prompt,
    files: options.file,
  });

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, bundle);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));

  const conversationContext = await resolveConversationContext();
  let storedConversation: StoredConversation | undefined;
  if (options.newChat) {
    // A new chat replaces the stored one, even if this run fails.
    await clearStoredConversation(conversationContext, providerName).catch(() => {});
  } else {
    storedConversation = await getStoredConversation(conversationContext, providerName);
  }
  if (storedConversation) {
    console.log(chalk.dim(`Reusing chat: ${storedConversation.id}`));
  }

  // Determine profile mode: CLI flag overrides config
  const profileMode = options.profile || options.isolatedProfile ? 'isolated' : config.profileMode;

  const op = {
    provider: providerName,
    operation: 'chat',
    url: provider.config.url,
    startedAt: Date.now(),
  };
  let stage = 'launch';

  // Launch browser — if this fails, mark session as failed
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: providerName,
      headless,
      url: storedConversation?.url ?? provider.config.url,
      profileMode,
      profile: options.profile,
      operation: 'chat',
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    throw browserError('Failed to launch browser for chat', { ...op, stage }, error);
  }

  let usingStoredConversation = Boolean(storedConversation);
  let freshRequired = !storedConversation;

  const startFreshConversation = async (): Promise<void> => {
    if (provider.actions.newChat) {
      await provider.actions.newChat(browser.page);
      return;
    }
    await browser.page.goto(provider.config.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  };

  const startNewConversation = async (): Promise<boolean> => {
    if (!usingStoredConversation) return false;
    console.log(chalk.dim('The stored chat is no longer available — starting a new one.'));
    usingStoredConversation = false;
    freshRequired = true;
    await clearStoredConversation(conversationContext, providerName).catch(() => {});
    await startFreshConversation();
    return true;
  };

  const ensureStoredConversation = async (): Promise<boolean> => {
    if (!usingStoredConversation || !storedConversation) return false;
    if (await isConversationGone(browser.page, providerName, storedConversation)) {
      return startNewConversation();
    }
    return false;
  };

  // A landing page may restore the last conversation (ChatGPT does). A run
  // without a stored conversation has to start a fresh one.
  const ensureFreshConversation = async (): Promise<boolean> => {
    if (!freshRequired || !provider.actions.newChat) return false;
    await provider.actions.newChat(browser.page);
    return true;
  };

  const sessionCheck = () =>
    checkProviderSession({
      page: browser.page,
      context: browser.context,
      provider,
      providerName,
      headless,
      sharedState: browser.sharedState,
    });

  const startTime = Date.now();

  try {
    stage = 'login-check';
    await ensureStoredConversation();
    try {
      await sessionCheck();
    } catch (error) {
      const gone = Boolean(
        usingStoredConversation &&
          storedConversation &&
          failureKind(error) === 'unauthorized' &&
          (await isConversationGone(browser.page, providerName, storedConversation).catch(
            () => false,
          )),
      );
      if (!gone) throw error;
      await startNewConversation();
      await sessionCheck();
    }

    // A client-side redirect can happen while the session check waits.
    if (await ensureStoredConversation()) {
      await sessionCheck();
    }

    const modelName = chatModel(options.model, config.defaultModel, provider.config.defaultModel);
    if (modelName && provider.actions.selectModel) {
      stage = 'select-model';
      console.log(chalk.dim(`Selecting model: ${modelName}`));
      await provider.actions.selectModel(browser.page, modelName);
    }

    if (options.attach && options.attach.length > 0) {
      stage = 'attach-files';
      if (!provider.actions.attachFiles) {
        console.warn(
          chalk.yellow(
            `⚠ Provider '${providerName}' does not support file attachments. --attach will be ignored.`,
          ),
        );
      } else {
        const resolvedPaths = await resolveAttachPaths(options.attach);
        if (resolvedPaths.length > 0) {
          console.log(chalk.dim(`Attaching ${resolvedPaths.length} file(s)...`));
          await provider.actions.attachFiles(browser.page, resolvedPaths);
        }
      }
    }

    // Do it after the model/files work and right before the prompt: the app
    // has fully hydrated by now, and a provider may have dropped the stored
    // conversation while the model picker was open.
    const restarted = await ensureStoredConversation();
    if (restarted) {
      await sessionCheck();
    } else {
      await ensureFreshConversation();
    }

    stage = 'submit-prompt';
    console.log(chalk.dim('Submitting prompt...'));
    await provider.actions.submitPrompt(browser.page, bundle);

    stage = 'capture-response';
    console.log(chalk.dim('Waiting for response...'));
    const captured = await provider.actions.captureResponse(browser.page, {
      timeoutMs,
      onChunk: (chunk) => process.stdout.write(chalk.dim(chunk)),
    });

    const durationMs = Date.now() - startTime;
    const conversationId = conversationIdFromUrl(providerName, browser.page.url());
    if (conversationId) {
      await saveStoredConversation(conversationContext, providerName, {
        url: browser.page.url(),
        id: conversationId,
        updatedAt: new Date().toISOString(),
      }).catch((error) => {
        console.warn(
          chalk.dim(
            `Could not save the conversation: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    }

    stage = 'save-response';
    await saveResponse(session.id, captured.text);

    let savedImages: GeneratedImage[] | undefined;
    if (captured.images && captured.images.length > 0) {
      stage = 'download-images';
      console.log(chalk.dim(`Found ${captured.images.length} generated image(s), downloading...`));
      savedImages = await downloadImages(
        browser.page,
        captured.images,
        session.id,
        options.saveImages,
      );
    }

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
      ...(savedImages && savedImages.length > 0 ? { images: savedImages } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });
    const kind = failureKind(error);
    if (kind) {
      // Keep the kind of the failure: the wrapper must not hide it.
      throw reclassify(
        kind,
        `${(error as Error).message} (provider=${providerName} stage=${stage})`,
      );
    }
    throw browserError('Chat operation failed', { ...op, stage }, error);
  } finally {
    await browser.close();
  }
}

export interface ChatAllResult {
  provider: ProviderName;
  result?: ChatResult;
  error?: string;
  /** The kind of the failure — the CLI turns it into a hint. */
  kind?: FailureKind;
}

/** The result of a provider that failed in a parallel run. */
export function failedChatAllResult(provider: ProviderName, error: unknown): ChatAllResult {
  return {
    provider,
    error: error instanceof Error ? error.message : String(error),
    kind: failureKind(error),
  };
}

/**
 * Run the same prompt against multiple providers in parallel.
 * Uses the shared browser daemon — all providers reuse one Chromium process.
 */
export async function runChatAll(options: ChatOptions): Promise<ChatAllResult[]> {
  const targets = options.providers ?? CHAT_PROVIDERS;

  console.log(chalk.bold.blue(`\n🚀 Sending to ${targets.length} providers in parallel...\n`));

  const tasks = targets.map(async (provider): Promise<ChatAllResult> => {
    try {
      const result = await runChat({ ...options, provider });
      return { provider, result };
    } catch (error) {
      return failedChatAllResult(provider, error);
    }
  });

  // Each task catches its own errors and resolves to a ChatAllResult, so it
  // never rejects — Promise.all preserves per-provider error attribution
  // (the previous Promise.allSettled fallback hard-coded provider: 'chatgpt').
  return Promise.all(tasks);
}
