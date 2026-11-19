import chalk from 'chalk';
import type { AiBackend } from '../backend/contract.js';
import { browserError } from '../browser/diagnostics.js';
import { launchBrowser } from '../browser/index.js';
import { resolveHeadlessMode } from '../browser/mode.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { CapturedResponse, ChatOptions, GeneratedImage, ProviderName } from '../types.js';
import { type ApiChatDeps, resolveTransport, runApiChat } from './api-orchestrator.js';
import { runBackendChat } from './backend-runner.js';
import { buildBundle } from './bundle.js';
import {
  clearStoredConversation,
  conversationIdFromUrl,
  getStoredConversation,
  isConversationGone,
  resolveConversationContext,
  type StoredConversation,
  storeCurrentConversation,
} from './conversations.js';
import type { FailureKind } from './failures.js';
import {
  ContextWindowFullError,
  checkProviderSession,
  failureKind,
  ProviderGenerationError,
  reclassify,
} from './failures.js';
import { resolveAttachPaths } from './files.js';
import { downloadImages } from './images.js';
import { chatModel } from './model.js';
import { chatTimeoutMs, isResponseTimeout } from './timeout.js';

/**
 * How many times a run continues the conversation in a new chat.
 *
 * Every continuation is a new chat with a summary: too many of them mean the
 * work does not fit into any context window.
 */
const MAX_CONTINUATIONS = 3;

/**
 * The extra window for the recovery of a cut-off answer.
 *
 * The capture of the answer was cut off by its timeout. The same turn is
 * captured again with this window: the prompt is not sent a second time,
 * because it may have run already.
 */
const RECOVERY_GRACE_MS = 5 * 60_000;

/** The length of the common prefix of two strings. */
function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index++;
  return index;
}

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
 * The dependencies of a chat run.
 *
 * The backend is the seam: a run with a backend never touches a browser.
 * Without one, the provider path of the browser runs as before.
 */
export interface ChatDeps extends ApiChatDeps {
  /** The backend of the run — the provider path is not used when it is set. */
  backend?: AiBackend;
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
 *
 * With a backend the prompt goes to that backend: no browser, no provider.
 */
export async function runChat(options: ChatOptions, deps: ChatDeps = {}): Promise<ChatResult> {
  if (deps.backend) {
    return runBackendChat(options, deps.backend);
  }

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
  // The files of the request: they are attached again when the conversation
  // continues in a new chat.
  let attachPaths: string[] | undefined;
  if (options.newChat) {
    // A new chat replaces the stored one, even if this run fails.
    await clearStoredConversation(conversationContext, providerName).catch(() => {});
  } else {
    storedConversation = await getStoredConversation(conversationContext, providerName);
  }
  if (storedConversation) {
    console.log(chalk.dim(`Reusing chat: ${storedConversation.id}`));
  } else {
    console.log(
      chalk.dim(`New chat (${conversationContext.repo} @ ${conversationContext.branch})`),
    );
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

  /** Is the context window of the current conversation exhausted? */
  const contextWindowFull = async (): Promise<boolean> => {
    if (!provider.actions.contextWindowFull) return false;
    return provider.actions.contextWindowFull(browser.page).catch(() => false);
  };

  /**
   * How many times this run has continued the conversation in a new chat.
   *
   * The counter belongs to the whole run: every path that continues the chat
   * counts, so the limit cannot be bypassed by a different path.
   */
  let continuations = 0;

  /**
   * The error of a run that continued the conversation too often.
   *
   * The same error on every path: the limit of the continuations is a
   * property of the run, not of the path that hit it.
   */
  const continuationLimitError = (): ProviderGenerationError =>
    new ProviderGenerationError(
      `The context window of the chat is full and the chat was already continued in a new one ${MAX_CONTINUATIONS} time(s).`,
    );

  /**
   * Continue the conversation in a new chat with an automatic summary.
   *
   * The new chat replaces the stored one: it is the working chat of this
   * repository and branch from now on, until its own context window runs out
   * too. The previous conversation stays until the new one has a permanent
   * URL — a run that fails in between must not lose the conversation.
   */
  const continueInNewChat = async (): Promise<boolean> => {
    if (!provider.actions.continueInNewChat) return false;
    // The limit is the same on every path: a chat that runs out again and
    // again does not fit into any context window.
    if (continuations >= MAX_CONTINUATIONS) {
      throw continuationLimitError();
    }
    console.log(
      chalk.dim(
        'The context window of the chat is full — continuing in a new chat with a summary.',
      ),
    );
    const started = await provider.actions.continueInNewChat(browser.page).catch(() => false);
    if (!started) return false;
    continuations++;

    usingStoredConversation = false;
    storedConversation = undefined;
    // The new chat is fresh: it must not be replaced by a blank one.
    freshRequired = false;

    // The files of the request belong to the old chat: they are attached
    // again in the new one, so the answer is not produced without them.
    if (attachPaths && provider.actions.attachFiles) {
      console.log(chalk.dim(`Attaching ${attachPaths.length} file(s) to the new chat...`));
      try {
        await provider.actions.attachFiles(browser.page, attachPaths);
      } catch (error) {
        // A failed attachment is not a warning: the prompt would be sent
        // without the files of the request, and the answer would be wrong
        // without anyone noticing.
        throw new ProviderGenerationError(
          `The files could not be attached to the new chat: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // The new chat replaces the stored one: it is the working chat of this
    // repository and branch from now on, until its own context window runs out
    // too. The previous conversation stays until the new one has a permanent
    // URL — a run that fails in between must not lose the conversation.
    const stored = await storeCurrentConversation(
      conversationContext,
      providerName,
      browser.page.url(),
    ).catch(() => false);
    if (!stored) {
      console.log(
        chalk.dim(
          'The new chat has no permanent URL yet — the previous conversation stays until it has one.',
        ),
      );
    }
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

    // A chat whose context window is exhausted cannot answer anymore. The
    // provider continues it in a new chat with an automatic summary, so the
    // work goes on instead of dying at the context limit.
    if (await contextWindowFull()) {
      const continued = await continueInNewChat();
      // The exhausted chat cannot answer: sending the prompt to it anyway
      // fails with a timeout and no answer at all.
      if (!continued) {
        throw new ProviderGenerationError(
          'The context window of the chat is full and the chat could not be continued in a new one.',
        );
      }
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
          attachPaths = resolvedPaths;
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

    // The answer is streamed to the terminal while it is generated. A
    // recovered answer is streamed again from its beginning: only the new
    // tail is printed, so the text does not appear twice.
    let printedText = '';
    const printChunk = (chunk: string) => {
      printedText += chunk;
      process.stdout.write(chalk.dim(chunk));
    };
    const printRecoveredChunk = (chunk: string) => {
      const fresh = chunk.slice(commonPrefixLength(printedText, chunk));
      if (!fresh) return;
      printedText += fresh;
      process.stdout.write(chalk.dim(fresh));
    };

    const submitAndCapture = async () => {
      stage = 'submit-prompt';
      console.log(chalk.dim('Submitting prompt...'));
      await provider.actions.submitPrompt(browser.page, bundle);

      // The chat gets its permanent URL when the first message is sent.
      // Store it right away: a run that fails while waiting for the answer
      // must not lose the conversation.
      await storeCurrentConversation(conversationContext, providerName, browser.page.url()).catch(
        () => false,
      );

      stage = 'capture-response';
      console.log(chalk.dim('Waiting for response...'));
      return provider.actions.captureResponse(browser.page, {
        timeoutMs,
        onChunk: printChunk,
      });
    };

    /**
     * The recovery of a cut-off answer.
     *
     * The same turn is captured again — the provider keeps the baseline of the
     * turn, so the capture finds the answer that is still coming. The prompt is
     * not sent again: it may have run already.
     */
    const recoverResponse = async () => {
      stage = 'capture-response';
      console.log(chalk.dim('The response was cut off — waiting for it to finish...'));
      return provider.actions.captureResponse(browser.page, {
        timeoutMs: Math.min(timeoutMs, RECOVERY_GRACE_MS),
        onChunk: printRecoveredChunk,
      });
    };

    // The prompt is sent once. A cut-off answer is recovered from the same
    // turn, and an error of the provider is asked again only when nothing was
    // produced: a prompt that may have run already is not sent twice.
    const hasAttachments = Boolean(options.attach && options.attach.length > 0);
    const askWithRetry = async () => {
      let retried = false;
      // The context window ran out while the answer was generated: the next
      // iteration continues the conversation in a new chat and asks again.
      let pendingContinuation = false;
      for (;;) {
        // The context window can run out during the run: continue in a new
        // chat with a summary and ask there.
        if (pendingContinuation || (await contextWindowFull())) {
          pendingContinuation = false;
          const continued = await continueInNewChat();
          // The exhausted chat cannot answer: the run fails with a clear
          // reason instead of a timeout without an answer.
          if (!continued) {
            throw new ProviderGenerationError(
              'The context window of the chat is full and the chat could not be continued in a new one.',
            );
          }
          await sessionCheck();
          if (modelName && provider.actions.selectModel) {
            await provider.actions.selectModel(browser.page, modelName);
          }
        }
        let captured: CapturedResponse;
        try {
          captured = await submitAndCapture();
        } catch (error) {
          // The context window ran out while the answer was generated: the
          // next iteration continues the conversation in a new chat and asks
          // again. The files of the request are attached to the new chat.
          if (error instanceof ContextWindowFullError) {
            if (continuations >= MAX_CONTINUATIONS) throw continuationLimitError();
            console.log(chalk.dim('The context window ran out — continuing in a new chat.'));
            pendingContinuation = true;
            continue;
          }
          // A new attempt: the prompt is sent again. It is only safe when the
          // provider produced nothing — a partial answer means that the task
          // of the prompt may have run already.
          if (
            retried ||
            hasAttachments ||
            !(error instanceof ProviderGenerationError) ||
            error.partial
          ) {
            throw error;
          }
          retried = true;
          console.log(
            chalk.dim(
              'The provider reported an error while generating — asking again (the prompt is sent a second time).',
            ),
          );
          continue;
        }
        if (!captured.truncated) return captured;

        // The answer was cut off: the same turn is captured again instead of
        // a new prompt — the prompt must not be executed a second time.
        try {
          const recovered = await recoverResponse();
          return recovered.truncated ? captured : recovered;
        } catch (error) {
          if (error instanceof ContextWindowFullError) {
            if (continuations >= MAX_CONTINUATIONS) throw continuationLimitError();
            console.log(chalk.dim('The context window ran out — continuing in a new chat.'));
            pendingContinuation = true;
            continue;
          }
          // The provider failed while the answer was recovered: the cut-off
          // answer is returned, the prompt is not sent again.
          return captured;
        }
      }
    };
    const captured = await askWithRetry();

    const durationMs = Date.now() - startTime;
    const conversationId = conversationIdFromUrl(providerName, browser.page.url());
    await storeCurrentConversation(conversationContext, providerName, browser.page.url()).catch(
      (error) => {
        console.warn(
          chalk.dim(
            `Could not save the conversation: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );

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
    const isTimeout = isResponseTimeout(error);
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
