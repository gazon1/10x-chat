import { describe, expect, it } from 'vitest';
import { createChromeUsePerplexityBackend } from '../../src/backend/chrome-use-perplexity.js';

const enabled = process.env.TEN_X_CHAT_E2E_CHROME_USE_PERPLEXITY === '1';

// Opt-in: needs chrome-use installed, Chrome with the extension connected, and
// network access to perplexity.ai in that browser profile.
describe.runIf(enabled)('chrome-use Perplexity backend (live smoke)', () => {
  it('answers a trivial prompt end-to-end', async () => {
    const backend = createChromeUsePerplexityBackend();
    const out = await backend.ask({
      requestId: `e2e-${Date.now()}`,
      prompt: 'Reply with exactly: POC_OK',
      timeoutMs: 120_000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.text.trim().length).toBeGreaterThan(0);
    expect(out.value.submission).toBe('submitted');
  }, 180_000);
});
