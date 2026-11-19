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
  response: BackendResponse;
  cancelled: boolean;
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

  const answer = (request: BackendRequest): BackendResponse => {
    const rule = ruleFor(request.prompt);
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

  const failureFor = (request: BackendRequest, kind: BackendFailureKind): BackendFailure => {
    const rule = ruleFor(request.prompt);
    return {
      kind,
      message: `The fake backend failed with '${kind}'.`,
      submission: SUBMISSION_OF_FAILURE[kind],
      ...(rule?.partial ? { partialText: rule.partial } : {}),
    };
  };

  const run = async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
    const rule = ruleFor(request.prompt);
    if (rule?.failure) {
      return { ok: false, failure: failureFor(request, rule.failure) };
    }
    const response = answer(request);
    const previous = known.get(request.requestId);
    known.set(request.requestId, {
      request,
      response,
      cancelled: previous?.cancelled === true,
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
        submission: 'submitted',
        text: entry.response.text,
        truncated: entry.response.truncated,
        cancelled: entry.cancelled,
        conversationId: entry.response.conversationId,
      };
    },

    resume: async (request: BackendRequest): Promise<BackendOutcome<BackendResponse>> => {
      if (!known.has(request.requestId)) {
        return {
          ok: false,
          failure: {
            kind: 'unknown_submission',
            message: `The fake backend does not know the request '${request.requestId}'.`,
            submission: 'not_submitted',
          },
        };
      }
      return run(request);
    },

    cancel: async (requestId: string): Promise<BackendOutcome<{ cancelled: boolean }>> => {
      const entry = known.get(requestId);
      if (!entry) {
        return {
          ok: false,
          failure: {
            kind: 'unknown_submission',
            message: `The fake backend does not know the request '${requestId}'.`,
            submission: 'not_submitted',
          },
        };
      }
      entry.cancelled = true;
      return { ok: true, value: { cancelled: true } };
    },
  };
}
