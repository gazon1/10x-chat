import { describe, expect, it } from 'vitest';
import {
  CHROME_USE_PERPLEXITY_BACKEND_NAME,
  createChromeUsePerplexityBackend,
  type ProcessResult,
  type ProcessRunner,
} from '../src/backend/chrome-use-perplexity.js';

interface Call {
  args: string[];
  timeoutMs?: number;
  input?: string;
}

function ok(data: unknown = {}): ProcessResult {
  return {
    code: 0,
    stdout: JSON.stringify({ success: true, data, error: null }),
    stderr: '',
    timedOut: false,
  };
}

function failJson(error: string): ProcessResult {
  return {
    code: 1,
    stdout: JSON.stringify({ success: false, data: null, error }),
    stderr: '',
    timedOut: false,
  };
}

describe('chrome-use Perplexity backend (POC)', () => {
  it('declares explicit unsupported capabilities', () => {
    const backend = createChromeUsePerplexityBackend({ runner: { run: async () => ok() } });
    expect(backend.name).toBe(CHROME_USE_PERPLEXITY_BACKEND_NAME);
    expect(backend.capabilities).toEqual({
      attachments: false,
      streaming: false,
      cancellation: false,
      conversationReuse: false,
      modelSelection: false,
      imageOutput: false,
      maxConcurrentRequests: 1,
    });
  });

  it('submits prompt, captures stable answer, and cleans up with done', async () => {
    const calls: Call[] = [];
    let prosePolls = 0;
    const runner: ProcessRunner = {
      run: async (_cmd, args, opts) => {
        calls.push({ args, timeoutMs: opts?.timeoutMs, input: opts?.input });
        const sub = args[2]; // --session <s> <sub>
        if (sub === 'open') return ok({ url: 'https://www.perplexity.ai' });
        if (sub === 'wait') return ok();
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          if (script.includes('return { count:n')) {
            prosePolls++;
            // 1: partial, 2-6: final text unchanged -> 5 consecutive stable polls
            const text = prosePolls >= 2 ? 'Paris is the capital of France.' : 'Paris is the';
            return ok({ result: { count: 1, text, html: `<p>${text}</p>` } });
          }
          // best-effort overlay dismiss eval
          return ok({ result: 0 });
        }
        if (sub === 'fill') return ok();
        if (sub === 'press') return ok();
        if (sub === 'click') return ok();
        if (sub === 'done') return ok({ closed: true });
        return ok();
      },
    };

    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'Capital of France?' });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.text).toBe('Paris is the capital of France.');
    expect(out.value.submission).toBe('submitted');
    expect(out.value.truncated).toBe(false);

    const fill = calls.find((c) => c.args[2] === 'fill');
    expect(fill?.args).toContain('--stdin');
    expect(fill?.input).toBe('Capital of France?');
    expect(calls.filter((c) => c.args[2] === 'click')).toHaveLength(1);
    expect(calls.some((c) => c.args[2] === 'done')).toBe(true);

    const status = await backend.status('req-1');
    expect(status.submission).toBe('submitted');
    expect(status.text).toBe('Paris is the capital of France.');
  });

  it('reports unavailable when chrome-use cannot be started', async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error('spawn chrome-use ENOENT');
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unavailable');
    expect(out.failure.submission).toBe('not_submitted');
  });

  it('tears no session down when chrome-use could not be started at all', async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push(args[2] ?? '');
        // The process could not be created — not the binary that is missing,
        // but the permission to run it.
        throw new Error('spawn chrome-use EACCES');
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    // No session was created, so there is nothing to close.
    expect(calls).not.toContain('done');
  });

  it('reports connection loss after submit as unknown submission', async () => {
    let submitted = false;
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        const sub = args[2];
        if (sub === 'open' || sub === 'wait' || sub === 'fill' || sub === 'press') return ok();
        if (sub === 'eval') {
          const script = args[3] ?? '';
          // Baseline count before submit.
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          // Polling snapshot after submit: simulate relay loss.
          if (submitted) return failJson('not connected to Chrome extension relay');
          return ok({ result: { count: 0, text: '', html: '' } });
        }
        if (sub === 'click') {
          submitted = true;
          return ok();
        }
        if (sub === 'done') return ok();
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi', timeoutMs: 5_000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unknown_submission');
    expect(out.failure.submission).toBe('unknown');
  });

  it('treats click failure as unknown submission and does not press Enter', async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        const sub = args[2];
        if (sub === 'open' || sub === 'wait' || sub === 'fill') return ok();
        if (sub === 'eval') return ok({ result: 0 });
        if (sub === 'press') return ok();
        if (sub === 'click') return failJson('relay connection lost');
        if (sub === 'done') return ok();
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unknown_submission');
    expect(out.failure.submission).toBe('unknown');
    expect(calls.filter((c) => c.args[2] === 'press' && c.args[3] === 'Enter')).toHaveLength(0);
  });

  it('treats ordinary click command failure as unknown submission (no retry)', async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        const sub = args[2];
        if (sub === 'open' || sub === 'wait' || sub === 'fill') return ok();
        if (sub === 'eval') return ok({ result: 0 });
        if (sub === 'press') return ok();
        if (sub === 'click') return failJson('element not clickable');
        if (sub === 'done') return ok();
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unknown_submission');
    expect(out.failure.submission).toBe('unknown');
    expect(calls.filter((c) => c.args[2] === 'press' && c.args[3] === 'Enter')).toHaveLength(0);
  });

  it('fails without submit when fill fallback reports prompt not entered', async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        const sub = args[2];
        if (sub === 'open' || sub === 'wait') return ok();
        if (sub === 'fill') return failJson('fill failed');
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script === '--stdin') return ok({ result: false });
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          return ok({ result: 0 });
        }
        if (sub === 'click' || sub === 'press') return ok();
        if (sub === 'done') return ok();
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unavailable');
    expect(out.failure.submission).toBe('not_submitted');
    expect(calls.some((c) => c.args[2] === 'click')).toBe(false);
  });

  it('reports pre-submit deadline expiry as unavailable/not_submitted', async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    // 0 or negative timeout => deadline already passed before any submit attempt.
    for (const timeoutMs of [0, -1]) {
      calls.length = 0;
      const out = await backend.ask({
        requestId: `req-timeout-${timeoutMs}`,
        prompt: 'hi',
        timeoutMs,
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.failure.kind).toBe('unavailable');
      expect(out.failure.submission).toBe('not_submitted');
      expect(out.failure.message).toMatch(/before the prompt was sent/);
      expect(calls).toHaveLength(0);
    }
  });

  it('reports pre-submit deadline expiry before click without submitting', async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        const sub = args[2];
        if (sub === 'press' && args[3] === 'Escape') {
          await new Promise((r) => setTimeout(r, 30));
        }
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          return ok({ result: 0 });
        }
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1 });
    const out = await backend.ask({ requestId: 'req-timeout2', prompt: 'hi', timeoutMs: 15 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unavailable');
    expect(out.failure.submission).toBe('not_submitted');
    expect(calls.some((c) => c.args[2] === 'click')).toBe(false);
  });

  it('waits for consecutive stable polls and does not return a paused intermediate answer', async () => {
    let prosePolls = 0;
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        const sub = args[2];
        if (
          sub === 'open' ||
          sub === 'wait' ||
          sub === 'fill' ||
          sub === 'press' ||
          sub === 'click' ||
          sub === 'done'
        )
          return ok();
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          if (script.includes('return { count:n')) {
            prosePolls++;
            // 1: partial, 2-4: same (pause, 3 stable < threshold), 5: longer (resumes), 6-10: final stable x5
            let text = 'Part 1';
            if (prosePolls >= 5) text = 'Part 1 and Part 2 complete';
            return ok({ result: { count: 1, text, html: `<p>${text}</p>` } });
          }
          return ok({ result: 0 });
        }
        return ok();
      },
    };
    // Threshold 5: a 3-poll pause must not be treated as complete.
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stablePolls: 5 });
    const out = await backend.ask({ requestId: 'req-pause', prompt: 'hi', timeoutMs: 5_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.text).toBe('Part 1 and Part 2 complete');
  });

  it('reports unknown submission state for an unknown request id', async () => {
    const backend = createChromeUsePerplexityBackend({ runner: { run: async () => ok() } });
    const status = await backend.status('never-seen');
    expect(status.submission).toBe('unknown');
  });

  it('declares serial capacity and cancels queued requests before start', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Call[] = [];
    let askCount = 0;
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args });
        const sub = args[2];
        if (sub === 'open') {
          askCount += 1;
          if (askCount === 1) await held;
          return ok();
        }
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          if (script.includes('return { count:n')) {
            return ok({ result: { count: 1, text: 'ok', html: '<p>ok</p>' } });
          }
          return ok({ result: 0 });
        }
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stablePolls: 1 });
    expect(backend.capabilities.maxConcurrentRequests).toBe(1);

    const controller = new AbortController();
    const first = backend.ask({ requestId: 'r1', prompt: 'one', timeoutMs: 5_000 });
    const second = backend.ask({
      requestId: 'r2',
      prompt: 'two',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    release?.();

    const [one, two] = await Promise.all([first, second]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(false);
    if (two.ok) return;
    expect(two.failure.kind).toBe('cancelled');
    expect(two.failure.submission).toBe('not_submitted');
    expect(calls.some((c) => c.args.includes('r2'))).toBe(false);
  });

  it('rejects attachments and model selection explicitly', async () => {
    const backend = createChromeUsePerplexityBackend({ runner: { run: async () => ok() } });
    const a = await backend.ask({ requestId: 'r', prompt: 'hi', attachments: ['/tmp/x'] });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.failure.message).toMatch(/attachments/);
    const m = await backend.ask({ requestId: 'r', prompt: 'hi', model: 'Pro' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.failure.message).toMatch(/model selection/);
  });
});
