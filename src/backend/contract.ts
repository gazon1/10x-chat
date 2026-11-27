/**
 * The seam between the application and whatever answers the prompt.
 *
 * Nothing in this file knows about a browser, a page, a selector or a
 * session: a backend is anything that can take a request and answer it — the
 * browser providers of today, an HTTP API, a CLI tool, or a fake for the
 * tests.
 */

/**
 * An image of an answer.
 *
 * The type lives here and not in the types of the providers: the contract
 * must not depend on the browser, and the types of the providers do.
 */
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
 * - `rejected`: the backend cannot take this request at all — it was refused
 *   before it ran, because it asks for something the backend does not have.
 */
export type BackendFailureKind =
  | 'busy'
  | 'unavailable'
  | 'timeout'
  | 'invalid_output'
  | 'cancelled'
  | 'unknown_submission'
  | 'rejected';

/**
 * The submission states each failure kind allows.
 *
 * A failure that claims another state contradicts itself — the application
 * cannot use it. The first state of a kind is the one a backend reports.
 */
export const SUBMISSIONS_OF_FAILURE: Record<BackendFailureKind, readonly BackendSubmission[]> = {
  // A busy backend either refused the request (it never reached the model) or
  // is still busy with it (the request reached the model and runs).
  busy: ['not_submitted', 'submitted'],
  unavailable: ['not_submitted'],
  timeout: ['submitted'],
  cancelled: ['submitted'],
  // An unusable answer may have reached the model or not — it reports the
  // state the backend claimed.
  invalid_output: ['submitted', 'not_submitted', 'unknown'],
  unknown_submission: ['unknown'],
  // A request the backend refuses never reaches the model.
  rejected: ['not_submitted'],
};

/** A failed request — never an empty successful answer. */
export interface BackendFailure {
  kind: BackendFailureKind;
  /** The message for the user. */
  message: string;
  /**
   * Whether the request reached the model.
   *
   * The state follows the kind: `busy` and `unavailable` never sent the
   * request (`not_submitted`), `timeout` and `cancelled` did (`submitted`),
   * and `unknown_submission` does not know (`unknown`). An `invalid_output`
   * reports what the backend claimed. A failure that contradicts itself
   * cannot be used.
   */
  submission: BackendSubmission;
  /** The output the backend produced before it failed. */
  partialText?: string;
  /**
   * How long the request waited for the backend to be free, in milliseconds.
   *
   * Absent when the backend does not queue its requests. A backend that runs
   * one request at a time measures the wait before it starts.
   */
  queueWaitMs?: number;
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
  /**
   * Where the backend saves the images of the answer.
   *
   * The application does not download them: it has no page with the cookies
   * of a provider. A backend that produces images saves them itself and
   * reports the local paths in the answer.
   *
   * The directory exists when the request is made — the one of the session,
   * unless the caller asked for another one.
   */
  saveDir?: string;
  /** The deadline of the request in milliseconds. */
  timeoutMs?: number;
  /**
   * Called with every piece of the answer, when the backend streams.
   *
   * The final answer of the response stays the whole text — the chunks are
   * only what the application shows while the answer is generated.
   */
  onChunk?: (chunk: string) => void;
  /**
   * The ChatGPT Project that receives a newly created conversation.
   *
   * The value is the project **name** as it appears in
   * `~/.chatgpt-use/projects.json` — the lookup key the `chatgpt-use` CLI
   * accepts. The id underneath the name is the real identity. A backend that
   * cannot file a conversation into a project rejects the request; it must
   * never silently create the conversation outside the project.
   */
  chatgptProject?: string;
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
  /**
   * How long the request waited for the backend to be free, in milliseconds.
   *
   * Absent when the backend does not queue its requests. The caller subtracts
   * it from its own wall clock to get the time the provider really took.
   */
  queueWaitMs?: number;
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
  readonly attachments: boolean;
  /** The answer arrives in pieces while it is generated — through `onChunk`. */
  readonly streaming: boolean;
  /** A running request can be cancelled. */
  readonly cancellation: boolean;
  /** A request can continue an existing conversation. */
  readonly conversationReuse: boolean;
  /** The caller can choose the model. */
  readonly modelSelection: boolean;
  /** The answer can contain images. */
  readonly imageOutput: boolean;
  /**
   * How many requests the backend can run at the same time.
   *
   * Absent or `1` means the backend is serial: the caller must not issue
   * concurrent requests to it. A value greater than `1` is the capacity the
   * caller may use; the pipeline uses it to decide whether independent
   * reviewer roles may run in parallel. The backend itself may still queue
   * internally, but the pipeline treats this as the safe concurrency limit.
   */
  readonly maxConcurrentRequests?: number;
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
  /**
   * The backend is a test double: its answers are canned.
   *
   * A command that a user drives must not offer such a backend — an answer
   * that is canned must never look like the answer of a provider.
   */
  readonly testDouble?: boolean;
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

/**
 * The outcome of a queued request, stamped with the wait it served.
 *
 * A backend that runs one request at a time knows the wait and the caller does
 * not: the value and the failure both carry it, so a failed request reports
 * its wait as well as a successful one. A measured wait of zero is stamped as
 * zero — it is a measurement, and an absent field would say that nobody
 * measured it.
 */
export function withQueueWait<T extends { queueWaitMs?: number }>(
  outcome: BackendOutcome<T>,
  queueWaitMs: number,
): BackendOutcome<T> {
  const wait = Math.max(0, queueWaitMs);
  return outcome.ok
    ? { ok: true, value: { ...outcome.value, queueWaitMs: wait } }
    : { ok: false, failure: { ...outcome.failure, queueWaitMs: wait } };
}
