import { describe, expect, it, vi } from 'vitest';
import { chatgptActions } from '../src/providers/chatgpt.js';

interface Snapshot {
  found: boolean;
  bodies: { text: string; html: string }[];
  errorText?: string;
}

function createCapturePage(opts: {
  turnCounts: number[];
  snapshots: Snapshot[];
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
      if (arg && typeof arg === 'object' && 'bodySelectors' in arg) {
        const snapshot = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
        return snapshot
          ? { found: snapshot.found, bodies: snapshot.bodies, errorText: snapshot.errorText ?? '' }
          : { found: false, bodies: [], errorText: '' };
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
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
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
          { found: true, bodies: [{ text: 'Hel', html: '<p>Hel</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
          { found: true, bodies: [{ text: 'Hello', html: '<p>Hello</p>' }] },
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

    it('joins an answer that the provider split into several messages', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          {
            found: true,
            bodies: [{ text: 'SEVERITY: MAJOR\nLOCATION: src/a.ts:1', html: '<p>MAJOR</p>' }],
          },
          {
            found: true,
            bodies: [
              { text: 'SEVERITY: MAJOR\nLOCATION: src/a.ts:1', html: '<p>MAJOR</p>' },
              { text: 'SEVERITY: MINOR\nLOCATION: src/b.ts:2', html: '<p>MINOR</p>' },
            ],
          },
          {
            found: true,
            bodies: [
              { text: 'SEVERITY: MAJOR\nLOCATION: src/a.ts:1', html: '<p>MAJOR</p>' },
              { text: 'SEVERITY: MINOR\nLOCATION: src/b.ts:2', html: '<p>MINOR</p>' },
            ],
          },
          {
            found: true,
            bodies: [
              { text: 'SEVERITY: MAJOR\nLOCATION: src/a.ts:1', html: '<p>MAJOR</p>' },
              { text: 'SEVERITY: MINOR\nLOCATION: src/b.ts:2', html: '<p>MINOR</p>' },
            ],
          },
          {
            found: true,
            bodies: [
              { text: 'SEVERITY: MAJOR\nLOCATION: src/a.ts:1', html: '<p>MAJOR</p>' },
              { text: 'SEVERITY: MINOR\nLOCATION: src/b.ts:2', html: '<p>MINOR</p>' },
            ],
          },
        ],
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
      });

      expect(response.text).toBe(
        'SEVERITY: MAJOR\nLOCATION: src/a.ts:1\n\nSEVERITY: MINOR\nLOCATION: src/b.ts:2',
      );
      expect(response.markdown).toBe('<p>MAJOR</p>\n\n<p>MINOR</p>');
    });

    it('does not end the capture on a stable activity label while generating', async () => {
      const label = {
        found: true,
        bodies: [{ text: 'Reviewed potential bugs', html: '<p>label</p>' }],
      };
      const answer = {
        found: true,
        bodies: [
          { text: 'Verdict: APPROVE. No blocking findings.', html: '<p>Verdict: APPROVE…</p>' },
        ],
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

      expect(response.text).toBe(answer.bodies[0].text);
      expect(response.truncated).toBe(false);
    });

    it('waits out a stable activity label even without the Stop button', async () => {
      const label = {
        found: true,
        bodies: [{ text: 'Reviewed potential bugs', html: '<p>label</p>' }],
      };
      const answer = {
        found: true,
        bodies: [
          { text: 'Verdict: APPROVE. No blocking findings.', html: '<p>Verdict: APPROVE…</p>' },
        ],
      };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [...Array(6).fill(label), ...Array(6).fill(answer)],
        stopVisible: () => false,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.bodies[0].text);
    });

    it('fails on a streaming error instead of waiting for the timeout', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          {
            found: false,
            bodies: [],
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
            bodies: [],
            errorText: 'Oops, the response could not be produced',
          },
        ],
        stopVisible: () => false,
      });

      await expect(
        chatgptActions.captureResponse(page as never, { timeoutMs: 30_000 }),
      ).rejects.toThrow(/reported an error while generating/);
    });

    it('does not mistake a long answer about a streaming error for a failure', async () => {
      const answer = {
        found: true,
        bodies: [
          {
            text: 'The capture reads the wrong node; a streaming error there loses half of the answer.',
            html: '<p>The capture reads the wrong node…</p>',
          },
        ],
      };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [answer, answer, answer, answer, answer],
        stopVisible: () => false,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.bodies[0].text);
    });

    it('does not stream the answer of the previous turn before the prompt is in the DOM', async () => {
      const oldAnswer = {
        found: true,
        bodies: [{ text: 'Answer of the previous turn', html: '<p>old</p>' }],
      };
      const newAnswer = {
        found: true,
        bodies: [{ text: 'Answer of this turn', html: '<p>new</p>' }],
      };
      // The DOM lags behind the submit: the prompt lands after two polls.
      let countCalls = 0;
      let userTurns = 1;
      const defaultLocator = {
        count: vi.fn(async () => 0),
        first: () => defaultLocator,
        last: () => defaultLocator,
        isVisible: vi.fn(async () => false),
      };
      const composer = {
        waitFor: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
        fill: vi.fn(async () => {}),
        evaluate: vi.fn(async () => false),
        isVisible: vi.fn(async () => true),
      };
      const page = {
        url: vi.fn(() => 'https://chatgpt.com'),
        waitForTimeout: vi.fn(async () => {}),
        locator: vi.fn((selector: string) => {
          if (selector.includes('composer')) return { first: () => composer };
          return defaultLocator;
        }),
        keyboard: {
          insertText: vi.fn(async () => {}),
          press: vi.fn(async () => {}),
          type: vi.fn(async () => {}),
        },
        evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
          if (arg && typeof arg === 'object' && 'bodySelectors' in arg) {
            return userTurns > 1 ? newAnswer : oldAnswer;
          }
          if (typeof arg === 'string') {
            countCalls++;
            if (countCalls > 2) userTurns = 2;
            return userTurns;
          }
          return false;
        }),
      };

      await chatgptActions.submitPrompt(page as never, 'the prompt');
      const chunks: string[] = [];
      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // The answer of the previous turn is still in the DOM: it must not be
      // taken for the answer of this run.
      expect(chunks.join('')).not.toContain('previous turn');
      expect(response.text).toBe('Answer of this turn');
    });

    it('accepts a short answer that looks like an activity label after a grace period', async () => {
      const answer = {
        found: true,
        bodies: [{ text: 'Read the PR description.', html: '<p>Read…</p>' }],
      };
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [answer],
        stopVisible: () => false,
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 30_000,
      });

      expect(response.text).toBe(answer.bodies[0].text);
      expect(response.truncated).toBe(false);
    });
  });
});
