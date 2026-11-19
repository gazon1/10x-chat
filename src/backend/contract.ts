import type { GeneratedImage } from '../types.js';

/**
 * The seam between the application and whatever answers the prompt.
 *
 * Nothing in this file knows about a browser, a page, a selector or a
 * session: a backend is anything that can take a request and answer it — the
 * browser providers of today, an HTTP API, a CLI tool, or a fake for the
 * tests.
 */

/**
 * Whether a request reached the model.
 *
 * The three states are not interchangeable: a request that was never
 * submitted can be sent again, a submitted one must not, and an unknown one
 * must be treated like a submitted one (the work may have run).
 */
export type BackendSubmission = 'not_submitted' | 'submitted' | 'unknown';

/**
 * Why a request failed.
 *
 * - `busy`: the backend cannot take the request right now.
 * - `unavailable`: the backend is not there.
 * - `timeout`: the answer did not arrive in time (or arrived cut off).
 * - `invalid_output`: the answer arrived, but it is not usable.
 * - `cancelled`: the request was cancelled.
 * - `unknown_submission`: the backend does not know whether the request ran.
 */
export type BackendFailureKind =
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'cancelled'
  | 'unknown_submission';

/** A failed request — never an empty successful answer. */
export interface BackendFailure {
  kind: BackendFailureKind;
  /** The message for the user. */
  message: string;
  /** Whether the request reached the model. */
  submission: BackendSubmission;
  /** The output the backend produced before it failed. */
  partialText?: string;
}

/** A request to a backend. */
export interface BackendRequest {
  /** The id of the request — it stays the same over status, resume and cancel. */
  requestId: string;
  /** The prompt to answer. */
  prompt: string;
  /** The model to use, when the backend has more than one. */
  model?: string;
  /** The conversation to continue, when the backend reuses conversations. */
  conversationId?: string;
  /** The files to attach. */
  attachments?: string[];
  /** The deadline of the request in milliseconds. */
  timeoutMs?: number;
  /**
   * Called with every piece of the answer, when the backend streams.
   *
   * The final answer of the response stays the whole text — the chunks are
   * only what the application shows while the answer is generated.
   */
  onChunk?: (chunk: string) => void;
}

/** The answer of a backend. */
export interface BackendResponse {
  /** The id of the request this answers. */
  requestId: string;
  /** The conversation the answer belongs to, when the backend has one. */
  conversationId?: string;
  /** The answer as text. */
  text: string;
  /** The answer as markdown, when the backend can produce it. */
  markdown?: string;
  /** The model that produced the answer. */
  model?: string;
  /** The answer was cut off — it is not complete. */
  truncated: boolean;
  /** Whether the request reached the model. */
  submission: BackendSubmission;
  /** The images of the answer, when the backend produces them. */
  images?: GeneratedImage[];
}

/** The state of a request that is known to the backend. */
export interface BackendStatus {
  requestId: string;
  /** Whether the request reached the model. */
  submission: BackendSubmission;
  /** The output produced so far. */
  text?: string;
  /** The output was cut off. */
  truncated?: boolean;
  /** The request was cancelled. */
  cancelled?: boolean;
  /** The conversation the request belongs to. */
  conversationId?: string;
}

/**
 * The result of an operation of a backend: either a value or a failure.
 *
 * A failure is never an empty value — a run that failed must not look like a
 * run that answered nothing.
 */
export type BackendOutcome<T> = { ok: true; value: T } | { ok: false; failure: BackendFailure };

/** What a backend can do. */
export interface BackendCapabilities {
  /** Files can be attached to the request. */
  attachments: boolean;
  /** The answer arrives in pieces while it is generated — through `onChunk`. */
  streaming: boolean;
  /** A running request can be cancelled. */
  cancellation: boolean;
  /** A request can continue an existing conversation. */
  conversationReuse: boolean;
  /** The caller can choose the model. */
  modelSelection: boolean;
  /** The answer can contain images. */
  imageOutput: boolean;
}

/**
 * The application-facing backend contract.
 *
 * `ask` sends a request and waits for the answer, `status` asks what happened
 * to a request, `resume` continues a request that was cut off, and `cancel`
 * stops a running request.
 */
export interface AiBackend {
  /** The name of the backend — the key of the registry. */
  readonly name: string;
  /** What the backend supports. */
  readonly capabilities: BackendCapabilities;
  /** Send a request and wait for the answer. */
  ask(request: BackendRequest): Promise<BackendOutcome<BackendResponse>>;
  /** The state of a request. */
  status(requestId: string): Promise<BackendStatus>;
  /** Continue a request that was cut off — the prompt is not sent again. */
  resume(request: BackendRequest): Promise<BackendOutcome<BackendResponse>>;
  /** Stop a running request. */
  cancel(requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>>;
}

/** A failure of a backend, as an error. */
export class BackendError extends Error {
  constructor(readonly failure: BackendFailure) {
    super(failure.message);
    this.name = 'BackendError';
  }
}

/** The kind of a backend failure, or undefined when the error is not one. */
export function backendFailureKind(error: unknown): BackendFailureKind | undefined {
  return error instanceof BackendError ? error.failure.kind : undefined;
}
