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
   * The site protects itself with a bot challenge (Cloudflare). The challenge
   * is a state of its own — it is neither "not logged in" nor "the site is
   * down" — and it can only be solved by a human in a visible window.
   */
  botProtected?: boolean;
  /**
   * The provider only works in a visible browser: headless Chromium is
   * blocked (bot protection) or serves a different DOM. The mode is decided
   * per provider here, not by a list of provider names in the code.
   */
  requiresHeaded?: boolean;
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

// ── Proxy Types ─────────────────────────────────────────────────

/**
 * The proxy of the config file.
 *
 * The credentials are not part of it: they live in the secrets file
 * (`~/.10x-chat/secrets.json`), so they never end up in a config file that is
 * copied around (see `docs/config-contract.md`).
 */
export interface ProxyConfig {
  /**
   * The explicit state of the proxy. `false` switches the proxy off and
   * suppresses the fallback to the proxy of the environment.
   */
  enabled: boolean;
  /**
   * The proxy URL without credentials, e.g. `http://proxy.example:3128`.
   * Required when `enabled` is `true`.
   */
  server?: string;
  /** The hosts that bypass the proxy. */
  bypass?: string[];
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
  /**
   * The proxy of the browser. Without this key the proxy of the environment is
   * used; with `enabled: false` there is no proxy at all.
   */
  proxy?: ProxyConfig;
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
