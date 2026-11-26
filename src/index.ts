export {
  type AiBackend,
  type BackendCapabilities,
  BackendError,
  type BackendFailure,
  type BackendFailureKind,
  type BackendOutcome,
  type BackendRequest,
  type BackendResponse,
  type BackendStatus,
  type BackendSubmission,
  backendFailureKind,
  type ChatgptUseBackendOptions,
  createChatgptUseBackend,
  createFakeBackend,
  type FakeBackendRule,
  getBackend,
  listBackends,
  type ProcessRunner,
  registerBackend,
  resetBackends,
} from './backend/index.js';
export { type BrowserSession, launchBrowser } from './browser/index.js';
export { loadConfig, resolveEffectiveProxy, saveConfig } from './config.js';
export { getProviderApiKey } from './core/credentials.js';
export {
  buildBundle,
  type ChatDeps,
  type ChatResult,
  runApiChat,
  runBackendChat,
  runChat,
} from './core/index.js';
export {
  createNotebookLmProvider,
  getKnowledgeProvider,
  type KnowledgeAnswer,
  KnowledgeError,
  type KnowledgeFailure,
  type KnowledgeFailureKind,
  type KnowledgeNotebook,
  type KnowledgeOutcome,
  type KnowledgeProvider,
  type KnowledgeProviderFactory,
  type KnowledgeProviderOptions,
  type KnowledgeReference,
  type KnowledgeSource,
  type KnowledgeStatus,
  listKnowledgeProviders,
  MAX_TIMEOUT_MS,
  NOTEBOOKLM_PROVIDER_NAME,
  type NotebookLmOptions,
  registerKnowledgeProvider,
} from './knowledge/index.js';
export { collectReviewContext, MAX_DIFF_CHARS } from './pipeline/context.js';
export {
  decisionId,
  dedupeDecisions,
  dedupeFindings,
  findingId,
  parseReviewerDecisions,
  parseReviewerFindings,
  parseVerdicts,
} from './pipeline/findings.js';
export {
  DEFAULT_REVIEW_PROFILE,
  isReviewProfile,
  REVIEW_PROFILE_COVERAGE,
  REVIEW_PROFILES,
} from './pipeline/profiles.js';
export { renderReviewReport } from './pipeline/report.js';
export {
  persistRun,
  REVIEW_STEP_IDS,
  runReviewPipeline,
} from './pipeline/review.js';
export type {
  Decision,
  DecisionKind,
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingVerification,
  ImprovementPriority,
  ReviewBackend,
  ReviewContext,
  ReviewImprovement,
  ReviewImprovements,
  ReviewProfile,
  ReviewRole,
  ReviewRun,
  ReviewTarget,
  StepOutcome,
  StepStatus,
} from './pipeline/types.js';
export { getApiTransport, listApiProviders } from './providers/api/registry.js';
export { getProvider, isValidProvider, listProviders } from './providers/index.js';
export {
  getSecretStore,
  getSecretsPath,
  PROXY_PASSWORD_SECRET,
  PROXY_USERNAME_SECRET,
  type SecretStore,
} from './secrets.js';
export {
  createSession,
  getSession,
  listSessions,
} from './session/index.js';
export type {
  ApiHttpClient,
  ApiHttpRequest,
  ApiHttpResponse,
  ApiRequest,
  ApiTransport,
  AppConfig,
  CapturedResponse,
  ChatOptions,
  CredentialStorage,
  ProfileMode,
  Provider,
  ProviderActions,
  ProviderConfig,
  ProviderName,
  SessionMeta,
  SessionResult,
  TransportCapabilities,
  TransportName,
} from './types.js';
