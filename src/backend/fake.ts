import type {
  AiBackend,
  BackendCapabilities,
  BackendFailure,
  BackendFailureKind,
  BackendOutcome,
  BackendRequest,
  BackendResponse,
  BackendStatus,
  BackendSubmission,
} from './contract.js';

/**
 * The outcome of a rule: what it answers with, or how it fails.
 *
 * It is a rule without its prompt — the outcome of a resume is bound to the
 * request of the rule it recovers.
 */
export type FakeBackendOutcome = Omit<FakeBackendRule, 'prompt' | 'resume'>;

/**
 * A rule of the fake backend: what it does with a prompt.
 *
 * The first rule whose prompt matches wins. A prompt without a rule is
 * answered with the default answer.
 */
export interface FakeBackendRule {
  /**
   * The prompt this rule answers.
   *
   * It matches the prompt of the request and the bundle that starts with it
   * (the bundle of a request is the prompt plus the files).
   */
  prompt: string;
  /** The answer of the rule. */
  answer?: string;
  /** The failure of the rule — the request fails instead of being answered. */
  failure?: BackendFailureKind;
  /** The output the backend produced before the failure. */
  partial?: string;
  /** The answer is cut off. */
  truncated?: boolean;
  /**
   * What a resume of this rule produces.
   *
   * Without it a resume repeats the rule and fails the same way — the
   * recovery of a failed request cannot be tested.
   */
  resume?: FakeBackendOutcome;
}

/**
 * The submission state of a failure.
 *
 * A backend that is busy or not there never sent the request; a backend that
 * failed while generating did send it; a backend that does not know must not
 * claim that the work did not run.
 */
const SUBMISSION_OF_FAILURE: Record<BackendFailureKind, BackendSubmission> = {
  busy: 'not_submitted',
  unavailable: 'not_submitted',
  timeout: 'submitted',
  invalid_output: 'submitted',
  cancelled: 'submitted',
  unknown_submission: 'unknown',
};

/** What the fake backend supports. */
export const FAKE_BACKEND_CAPABILITIES: BackendCapabilities = {
  attachments: true,
  streaming: false,
  cancellation: true,
  conversationReuse: true,
  modelSelection: true,
  imageOutput: false,
};

/** The state of a request the fake backend knows. */
interface KnownRequest {
  request: BackendRequest;
  /** The answer — a failed request has none. */
  response?: BackendResponse;
  /** The failure of the request — a failed request has no answer. */
  failure?: BackendFailure;
  /** Whether the request reached the model. */
  submission: BackendSubmission;
  cancelled: boolean;
  /** The request is still running — a cancel can still reach it. */
  running: boolean;
}

/**
 * A deterministic backend for the unit and the pipeline tests.
 *
 * The same request always produces the same answer, and a rule decides the
 * failure a prompt produces — no network, no browser, no clock.
 */
export function createFakeBackend(rules: FakeBackendRule[] = []): AiBackend {
  const known = new Map<string, KnownRequest>();

  const ruleFor = (prompt: string): FakeBackendRule | undefined => {
    const target = prompt.trim();
    return rules.find((rule) => {
      const candidate = rule.prompt.trim();
      return target === candidate || target.startsWith(`${candidate}\n`);
    });
  };

  const answer = (request: BackendRequest, rule?: FakeBackendOutcome): BackendResponse => {
    return {
      requestId: request.requestId,
      conversationId: request.conversationId ?? `fake-conversation-${request.requestId}`,
      text: rule?.answer ?? `Fake answer for: ${request.prompt}`,
      markdown: rule?.answer ?? `Fake answer for: ${request.prompt}`,
      model: request.model,
      truncated: rule?.truncated === true,
      submission: 'submitted',
    };
  };

  const failureFor = (kind: BackendFailureKind, rule?: FakeBackendOutcome): BackendFailure => {
    return {
      kind,
      message: `The fake backend failed with '${kind}'.`,
      submission: SUBMISSION_OF_FAILURE[kind],
      ...(rule?.partial ? { partialText: rule.partial } : {}),
    };
  };

  const run = async (
    request: BackendRequest,
    override?: FakeBackendOutcome,
  ): Promise<BackendOutcome<BackendResponse>> => {
    const rule = override ?? ruleFor(request.prompt);
    const previous = known.get(request.requestId);
    // The request runs now: a cancel that arrives before the answer ends it.
    known.set(request.requestId, {
      request,
      submission: 'submitted',
      cancelled: previous?.cancelled === true,
      running: true,
    });
    // The yield opens the window in which a cancel reaches the request.
    await Promise.resolve();
    if (known.get(request.requestId)?.cancelled === true) {
      known.set(request.requestId, {
        request,
        submission: 'submitted',
        cancelled: true,
        running: false,
      });
      return {
        ok: false,
        failure: {
          kind: 'cancelled',
          message: 'The request was cancelled.',
          submission: 'submitted',
        },
      };
    }
    if (rule?.failure) {
      const failure = failureFor(rule.failure, rule);
      // The request is remembered even when it failed: a timeout was sent,
      // and the status of the request must say so.
      known.set(request.requestId, {
        request,
        failure,
        submission: failure.submission,
        cancelled: previous?.cancelled === true,
        running: false,
      });
      return { ok: false, failure };
    }
    const response = answer(request, rule);
    known.set(request.requestId, {
      request,
      response,
      submission: 'submitted',
      cancelled: previous?.cancelled === true,
      running: false,
    });
    return { ok: true, value: response };
  };

  return {
    name: 'fake',
    capabilities: FAKE_BACKEND_CAPABILITIES,

    ask: run,

    status: async (requestId: string): Promise<BackendStatus> => {
      const entry = known.get(requestId);
      // The backend has no record of the request: it never sent it.
      if (!entry) return { requestId, submission: 'not_submitted' };
      return {
        requestId,
        submission: entry.submission,
        ...(entry.response
          ? {
              text: entry.response.text,
              truncated: entry.response.truncated,
              conversationId: entry.response.conversationId,
            }
          : {}),
        cancelled: entry.cancelled,
      };
    },

    resume: async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
      const entry = known.get(request.requestId);
      if (!entry) {
        return {
          ok: false,
          failure: {
            kind: 'unknown_submission',
            message: `The fake backend does not know the request '${request.requestId}'.`,
            // The backend cannot tell whether the request ran.
            submission: 'unknown',
          },
        };
      }
      // A request that has already answered is not continued: the answer
      // that is recorded stays the answer of the request.
      if (entry.response) return { ok: true, value: entry.response };
      // A request that never reached the model cannot be continued either —
      // it has to be sent again.
      if (entry.submission === 'not_submitted') {
        return {
          ok: false,
          failure: {
            kind: entry.failure?.kind ?? 'unknown_submission',
            message: `The request '${request.requestId}' was never submitted — it must be sent again.`,
            submission: 'not_submitted',
          },
        };
      }
      // The prompt of a resume is the prompt of the recorded request: a
      // resume never sends a new prompt. The outcome of the resume is the
      // recovery of the rule, when it has one.
      const rule = ruleFor(entry.request.prompt);
      return run(entry.request, rule?.resume);
    },

    cancel: async (requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>> => {
      const entry = known.get(requestId);
      if (!entry) {
        return {
          ok: false,
          failure: {
            kind: 'unknown_submission',
            message: `The fake backend does not know the request '${requestId}'.`,
            submission: 'unknown',
          },
        };
      }
      // A finished request cannot be cancelled — there is nothing running.
      if (!entry.running) return { ok: true, value: { cancelled: false } };
      entry.cancelled = true;
      return { ok: true, value: { cancelled: true } };
    },
  };
}
