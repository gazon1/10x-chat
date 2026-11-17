import { ApiRequestError } from '../../core/failures.js';
import type { ApiRequest, ApiTransport, CapturedResponse } from '../../types.js';

/** The endpoint of the chat completion of DeepSeek. */
const API_URL = 'https://api.deepseek.com/chat/completions';

/** The shape of the answer of the API (only the fields that are used). */
interface ChatCompletion {
  model?: string;
  choices?: {
    message?: { content?: string };
    finish_reason?: string;
  }[];
}

/**
 * The message of an error answer of the API.
 *
 * The body of an error can be anything, so it is cut short: a whole error
 * page of a proxy would drown the message of the API.
 */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — the body is used as it is.
  }
  return body.slice(0, 200);
}

/**
 * The API transport of DeepSeek.
 *
 * The API is the OpenAI-compatible one: a POST with the prompt and the model,
 * a JSON answer with the message of the assistant.
 */
export const deepseekApiTransport: ApiTransport = {
  capabilities: {
    attachments: false,
    streaming: false,
    cancellation: false,
  },

  async send(req: ApiRequest): Promise<CapturedResponse> {
    const response = await req.client.request({
      url: API_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? 'deepseek-chat',
        messages: [{ role: 'user', content: req.prompt }],
        stream: false,
      }),
      timeoutMs: req.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new ApiRequestError(
        response.status,
        `The DeepSeek API answered with HTTP ${response.status}: ${errorMessage(response.text)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error('The DeepSeek API answered with a malformed body — it is not JSON.');
    }

    const completion = parsed as ChatCompletion;
    const choice = completion.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('The DeepSeek API answered with a malformed body — no message content.');
    }

    return {
      text,
      markdown: text,
      ...(completion.model ? { model: completion.model } : {}),
      // The answer was cut off by the API itself, not by the timeout of the run.
      truncated: choice?.finish_reason === 'length',
    };
  },
};
