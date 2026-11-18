import { describe, expect, it, vi } from 'vitest';
import { chatgptActions } from '../src/providers/chatgpt.js';

function createCapturePage(opts: {
  turnCounts: number[];
  snapshots: Array<{ found: boolean; text: string; html: string; errorText?: string }>;
  /** Is the Stop button visible on the given capture poll? */
  stopVisible?: (poll: number) => boolean;
}) {
  const { turnCounts, snapshots } = opts;
  let turnCountIndex = 0;
  let snapshotIndex = 0;
  let pollIndex = 0;

  const stopButtonLocator = {
    first: () => stopButtonLocator,
    count: vi.fn(async () => 1),
    nth: () => stopButtonLocator,
    isVisible: vi.fn(async () => opts.stopVisible?.(pollIndex++) ?? false),
  };

  const defaultLocator = {
    count: vi.fn(async () => 0),
    first: () => defaultLocator,
    last: () => defaultLocator,
    isVisible: vi.fn(async () => false),
  };

  const page = {
    url: vi.fn(() => 'https://chatgpt.com'),
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => {
      if (selector.includes('Stop')) return stopButtonLocator;
      if (selector === 'div.agent-turn') {
        return {
          ...defaultLocator,
          count: vi.fn(
            async () => turnCounts[Math.min(turnCountIndex++, turnCounts.length - 1)] ?? 0,
          ),
        };
      }
      return defaultLocator;
    }),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (Array.isArray(arg)) {
        const snapshot = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
        return snapshot ? { ...snapshot, errorText: snapshot.errorText ?? '' } : undefined;
      }
      return [];
    }),
  };

  return { page };
}

describe('ChatGPT Provider', () => {
  describe('captureResponse', () => {
    it('captures response text and markdown via page.evaluate snapshots', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
        ],
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
      });

      expect(response.text).toBe('Hello');
      expect(response.markdown).toBe('<p>Hello</p>');
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('streams chunk deltas from evaluate-based snapshots', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          { found: true, text: 'Hel', html: '<p>Hel</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
        ],
      });

      const chunks: string[] = [];
      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(response.text).toBe('Hello');
      expect(chunks).toContain('Hel');
      expect(chunks).toContain('lo');
    });

    it('does not end the capture on a stable activity label while generating', async () => {
      const label = { found: true, text: 'Reviewed potential bugs', html: '<p>label</p>' };
      const answer = {
        found: true,
        text: 'Verdict: APPROVE. No blocking findings.',
        html: '<p>Verdict: APPROVE…</p>',
      };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        // The label stays unchanged for longer than the stability threshold.
        snapshots: [...Array(6).fill(label), ...Array(6).fill(answer)],
        stopVisible: (poll) => poll < 6,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.text);
      expect(response.truncated).toBe(false);
    });

    it('waits out a stable activity label even without the Stop button', async () => {
      const label = { found: true, text: 'Reviewed potential bugs', html: '<p>label</p>' };
      const answer = {
        found: true,
        text: 'Verdict: APPROVE. No blocking findings.',
        html: '<p>Verdict: APPROVE…</p>',
      };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [...Array(6).fill(label), ...Array(6).fill(answer)],
        stopVisible: () => false,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.text);
    });

    it('fails on a streaming error instead of waiting for the timeout', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          {
            found: false,
            text: '',
            html: '',
            errorText: 'Something went wrong while generating the response',
          },
        ],
        stopVisible: () => false,
      });

      await expect(
        chatgptActions.captureResponse(page as never, { timeoutMs: 30_000 }),
      ).rejects.toThrow(/reported an error while generating/);
    });

    it('fails on an unknown error wording in an error element', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          {
            found: false,
            text: '',
            html: '',
            errorText: 'Oops, the response could not be produced',
          },
        ],
        stopVisible: () => false,
      });

      await expect(
        chatgptActions.captureResponse(page as never, { timeoutMs: 30_000 }),
      ).rejects.toThrow(/reported an error while generating/);
    });

    it('accepts a short answer that looks like an activity label after a grace period', async () => {
      const answer = { found: true, text: 'Read the PR description.', html: '<p>Read…</p>' };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [answer],
        stopVisible: () => false,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.text);
      expect(response.truncated).toBe(false);
    });
  });
});
