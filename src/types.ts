import type { Page } from 'playwright';

// ── Profile Types ───────────────────────────────────────────────

/**
 * Profile mode controls how browser profiles are managed:
 * - 'shared': Single profile for all providers (login once, shared cookies). Default.
 *   Multiple non-persistent sessions can run truly in parallel — no locks.
 * - 'isolated': Separate profile per provider (original behavior, login per provider).
 */
export type ProfileMode = 'shared' | 'isolated';

// ── Provider Types ──────────────────────────────────────────────

export type ProviderName = 'chatgpt' | 'gemini' | 'claude' | 'grok' | 'perplexity' | 'deepseek';

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  url: string;
  loginUrl: string;
  models?: string[];
  defaultModel?: string;
  defaultTimeoutMs: number;
  /**
   * If true, the provider's site uses bot-detection (e.g. Cloudflare) that
   * permanently blocks headless Chromium. Chat sessions will automatically
   * run in headed (visible browser) mode for this provider.
   */
  headlessBlocked?: boolean;
}

export interface GeneratedImage {
  /** Source URL of the generated image (may require auth cookies). */
  url: string;
  /** Alt text or description. */
  alt?: string;
  /** Natural width in pixels. */
  width?: number;
  /** Natural height in pixels. */
  height?: number;
  /** Local file path after download (set by orchestrator). */
  localPath?: string;
}

export interface CapturedResponse {
  text: string;
  markdown: string;
  model?: string;
  thinkingTime?: number;
  truncated: boolean;
  /** Images generated in the response (e.g. DALL-E, Imagen). */
  images?: GeneratedImage[];
}

export interface ProviderActions {
  /** Check if the user is currently authenticated. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** Select a specific model if the provider has a model picker UI. */
  selectModel?(page: Page, model: string): Promise<void>;

  /** Submit a prompt (type into composer, click send). */
  submitPrompt(page: Page, prompt: string): Promise<void>;

  /** Attach files (images, documents) to the composer before sending. */
  attachFiles?(page: Page, filePaths: string[]): Promise<void>;

  /** Wait for the assistant response and extract it. */
  captureResponse(
    page: Page,
    opts: {
      timeoutMs: number;
      onChunk?: (chunk: string) => void;
    },
  ): Promise<CapturedResponse>;
}

export interface Provider {
  config: ProviderConfig;
  actions: ProviderActions;
}

// ── Session Types ───────────────────────────────────────────────

export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

export interface SessionMeta {
  id: string;
  provider: ProviderName;
  model?: string;
  promptPreview: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  durationMs?: number;
}

export interface SessionResult {
  meta: SessionMeta;
  bundlePath: string;
  responsePath?: string;
}

// ── Config Types ────────────────────────────────────────────────

export interface AppConfig {
  defaultProvider: ProviderName;
  defaultModel?: string;
  /**
   * Timeout of a chat (`chat`, `delegate`), in milliseconds. Unset means "use
   * the default of the provider". The commands `image` and `research` have
   * their own defaults and are not changed by it (see
   * `docs/config-contract.md`).
   */
  defaultTimeoutMs?: number;
  headless: boolean;
  /** Profile mode: 'shared' (default, single profile) or 'isolated' (per-provider profiles). */
  profileMode: ProfileMode;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProvider: 'chatgpt',
  headless: true,
  profileMode: 'shared',
};

// ── CLI Option Types ────────────────────────────────────────────

export interface ChatOptions {
  prompt: string;
  provider?: ProviderName;
  providers?: ProviderName[];
  model?: string;
  file?: string[];
  attach?: string[];
  copy?: boolean;
  dryRun?: boolean;
  headed?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  /** Directory to save generated images. Defaults to session dir. */
  saveImages?: string;
  /** Override to use isolated (per-provider) profiles regardless of config. */
  isolatedProfile?: boolean;
  /** Named browser profile under ~/.10x-chat/profiles/<name>. */
  profile?: string;
}

// ── Research Types ──────────────────────────────────────────────

export interface ResearchOptions {
  prompt: string;
  provider?: ProviderName;
  headed?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Optional model/mode to select before activating research (e.g. Gemini Deep Think). */
  model?: string;
  saveDir?: string;
  attach?: string[];
  isolatedProfile?: boolean;
  /** Named browser profile under ~/.10x-chat/profiles/<name>. */
  profile?: string;
}

export interface ResearchResult {
  sessionId: string;
  provider: ProviderName;
  report: string;
  truncated: boolean;
  durationMs: number;
  savedPath?: string;
}

// ── Image Generation Types ──────────────────────────────────────

export interface ImageGenOptions {
  prompt: string;
  provider?: ProviderName;
  headed?: boolean;
  timeoutMs?: number;
  saveDir?: string;
  isolatedProfile?: boolean;
}

export interface ImageGenResult {
  sessionId: string;
  provider: ProviderName;
  images: GeneratedImage[];
  text: string;
  truncated: boolean;
  durationMs: number;
}
