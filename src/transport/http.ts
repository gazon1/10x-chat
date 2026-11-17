import type { BrowserProxy } from '../browser/proxy.js';
import type { ApiHttpClient, ApiHttpRequest, ApiHttpResponse } from '../types.js';

/**
 * The HTTP client of the API transports.
 *
 * The request context of Playwright is used: the project depends on it
 * already, it needs no browser, and it honors the effective proxy — including
 * the credentials, which stay inside Playwright and never reach the command
 * line of a process (the browser path hands the same proxy to Playwright for
 * the same reason).
 *
 * Playwright is imported lazily: a run that uses a fake client never loads it.
 */
export function createApiHttpClient(proxy: BrowserProxy | null): ApiHttpClient {
  return {
    async request(req: ApiHttpRequest): Promise<ApiHttpResponse> {
      const { request } = await import('playwright');
      const context = await request.newContext(
        proxy
          ? {
              proxy: {
                server: proxy.server,
                ...(proxy.username ? { username: proxy.username } : {}),
                ...(proxy.password ? { password: proxy.password } : {}),
                ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
              },
            }
          : {},
      );

      try {
        const response = await context.fetch(req.url, {
          method: req.method ?? 'POST',
          headers: req.headers,
          data: req.body,
          timeout: req.timeoutMs,
        });
        return { status: response.status(), text: await response.text() };
      } finally {
        await context.dispose();
      }
    },
  };
}
