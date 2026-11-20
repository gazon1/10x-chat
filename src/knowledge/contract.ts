/**
 * The seam between the application and a source of knowledge.
 *
 * A knowledge provider is not a chat provider and not an `AiBackend`: it
 * keeps a collection of notebooks and their sources and answers questions
 * about them. Nothing in this file knows about a browser, a page or a
 * session — a provider is anything that can hold notebooks and answer a
 * question about their content.
 */

/**
 * Why a knowledge operation failed.
 *
 * - `unavailable`: the provider is not there (no executable, no network).
 * - `unauthorized`: the provider is not logged in.
 * - `timeout`: the answer did not arrive in time.
 * - `cancelled`: the operation was cancelled.
 * - `rate_limited`: the provider refused the operation for now.
 * - `invalid_output`: the provider answered, but the answer is not usable.
 * - `rejected`: the provider refused the operation (no such notebook, no
 *   quota, a bad request).
 */
export type KnowledgeFailureKind =
  | 'unavailable'
  | 'unauthorized'
  | 'timeout'
  | 'cancelled'
  | 'rate_limited'
  | 'invalid_output'
  | 'rejected';

/** A failed operation — never an empty value. */
export interface KnowledgeFailure {
  kind: KnowledgeFailureKind;
  /** The message for the user. */
  message: string;
  /** The code the upstream reported, when it reported one. */
  code?: string;
  /**
   * The operation may have reached the provider.
   *
   * A mutation (a new source, a refresh, a question) that timed out or
   * answered with garbage may have run: it must not be sent again blind.
   */
  mayHaveRun?: boolean;
}

/**
 * The result of an operation of a knowledge provider.
 *
 * A failure is never an empty value — a run that failed must not look like a
 * run that found nothing.
 */
export type KnowledgeOutcome<T> = { ok: true; value: T } | { ok: false; failure: KnowledgeFailure };

/** A notebook of a knowledge provider. */
export interface KnowledgeNotebook {
  id: string;
  title: string;
  /** The role of the caller in the notebook — `owner`, `editor`, `viewer`. */
  role?: string;
  /** The ISO date of the creation, when the provider reports one. */
  createdAt?: string;
}

/** A source of a notebook. */
export interface KnowledgeSource {
  id: string;
  title: string;
  /** The kind of the source — `url`, `text`, `file`, `youtube`. */
  type?: string;
  url?: string;
  /** The state of the source — `ready`, `processing`, `error`, ... */
  status?: string;
}

/** A citation of an answer. */
export interface KnowledgeReference {
  /** The id of the cited source. */
  sourceId: string;
  /** The number of the citation in the answer — the `[1]` of the text. */
  citationNumber?: number;
}

/** The answer of a question about a notebook. */
export interface KnowledgeAnswer {
  answer: string;
  /** The conversation the answer belongs to, when the provider has one. */
  conversationId?: string;
  /** The sources the answer cites. */
  references?: KnowledgeReference[];
}

/** The state of a knowledge provider. */
export interface KnowledgeStatus {
  /** The provider is installed and can be started. */
  available: boolean;
  /** The provider is logged in. */
  authenticated: boolean;
  /** The profile the provider was asked to use. */
  profile?: string;
  /** Why the provider is not usable, when it is not. */
  message?: string;
}

/** The options every knowledge provider accepts. */
export interface KnowledgeProviderOptions {
  /** The profile of the session of the provider to use. */
  profile?: string;
  /** The deadline of an operation in milliseconds. */
  timeoutMs?: number;
}

/** What a knowledge provider can do. */
export interface KnowledgeProvider {
  /** The name of the provider — the key of the registry. */
  readonly name: string;
  /** Is the provider there, and is it logged in? */
  status(): Promise<KnowledgeOutcome<KnowledgeStatus>>;
  /** The notebooks of the caller. */
  listNotebooks(): Promise<KnowledgeOutcome<KnowledgeNotebook[]>>;
  /** Create a notebook. */
  createNotebook(title: string): Promise<KnowledgeOutcome<KnowledgeNotebook>>;
  /** Add a source to a notebook. */
  addSource(notebookId: string, url: string): Promise<KnowledgeOutcome<KnowledgeSource>>;
  /** The sources of a notebook. */
  listSources(notebookId: string): Promise<KnowledgeOutcome<KnowledgeSource[]>>;
  /** Refresh a source of a notebook. */
  refreshSource(notebookId: string, sourceId: string): Promise<KnowledgeOutcome<KnowledgeSource>>;
  /** Ask a question about a notebook. */
  ask(
    notebookId: string,
    question: string,
    options?: { sources?: string[] },
  ): Promise<KnowledgeOutcome<KnowledgeAnswer>>;
}

/** A failure of a knowledge provider, as an error. */
export class KnowledgeError extends Error {
  constructor(readonly failure: KnowledgeFailure) {
    super(failure.message);
    this.name = 'KnowledgeError';
  }
}
