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

  /**
   * Start a new conversation. The landing page of some providers restores the
   * last chat instead of starting a new one; this action forces a fresh one.
   */
  newChat?(page: Page): Promise<void>;

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

// ── Transport Types ─────────────────────────────────────────────

/**
 * The transport that carries a prompt to a provider.
 *
 * `browser` (the default) drives the web app of the provider; `api` sends the
 * prompt to the HTTP API of the provider with the configured API key.
 */
export type TransportName = 'browser' | 'api';

/**
 * What a transport can do.
 *
 * A capability that a transport does not have is rejected with an error, never
 * silently ignored — a prompt that is sent without its attachment is worse than
 * a run that fails.
 */
export interface TransportCapabilities {
  /** Files can be attached to the prompt. */
  attachments: boolean;
  /** The answer arrives in pieces while it is generated. */
  streaming: boolean;
  /** The request can be cancelled while it runs. */
  cancellation: boolean;
}

/** A request of the shared HTTP client of the API transports. */
export interface ApiHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The deadline of the request in milliseconds. */
  timeoutMs: number;
}

/** The answer of the shared HTTP client. */
export interface ApiHttpResponse {
  status: number;
  /** The body of the answer. */
  text: string;
}

/**
 * The shared HTTP client of the API transports.
 *
 * It is an interface, so a transport can be tested without a network — and
 * without a browser.
 */
export interface ApiHttpClient {
  request(req: ApiHttpRequest): Promise<ApiHttpResponse>;
}

/** What an API transport receives. */
export interface ApiRequest {
  /** The prompt — the bundle of the prompt and the files. */
  prompt: string;
  /** The model to use, when the provider has more than one. */
  model?: string;
  /** The API key of the provider — never logged, never in an error. */
  apiKey: string;
  /** The deadline of the request in milliseconds. */
  timeoutMs: number;
  /** The shared HTTP client — it honors the effective proxy. */
  client: ApiHttpClient;
}

/**
 * The API transport of a provider.
 *
 * It is independent of the browser: no selectors, no login check, no page.
 */
export interface ApiTransport {
  /** What the transport supports. */
  capabilities: TransportCapabilities;
  /** Send a prompt and return the normalized response. */
  send(req: ApiRequest): Promise<CapturedResponse>;
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
 * The credentials are not part of it: they live in the secrets store (the
 * system keyring or `~/.10x-chat/secrets.json`), so they never end up in a
 * config file that is copied around (see `docs/config-contract.md`).
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

/**
 * Where the secrets of the store are kept.
 *
 * - `auto` (default): the system keyring when it is reachable, the file
 *   otherwise.
 * - `keyring`: the system keyring only — a run without it fails instead of
 *   falling back to a plaintext file.
 * - `file`: the file store only.
 */
export type CredentialStorage = 'auto' | 'keyring' | 'file';

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
   * The name of the secret that holds the API key of a provider, per provider.
   * The keys themselves live in the secrets store, never in this file.
   */
  providerKeys?: Partial<Record<ProviderName, string>>;
  /**
   * The proxy of the browser. Without this key the proxy of the environment is
   * used; with `enabled: false` there is no proxy at all.
   */
  proxy?: ProxyConfig;
  /**
   * Where the secrets live: the system keyring, the file, or the first that
   * works (`auto`, the default).
   */
  credentialStorage?: CredentialStorage;
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
  /** The transport to use: 'browser' (the default) or 'api'. */
  transport?: TransportName;
  /** Start a new conversation instead of reusing the stored one. */
  newChat?: boolean;
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
