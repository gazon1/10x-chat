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
  return { code: 0, stdout: JSON.stringify({ success: true, data, error: null }), stderr: '', timedOut: false };
}

function failJson(error: string): ProcessResult {
  return { code: 1, stdout: JSON.stringify({ success: false, data: null, error }), stderr: '', timedOut: false };
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

    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'Capital of France?' });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.text).toContain('Paris');
    expect(out.value.submission).toBe('submitted');
    expect(out.value.truncated).toBe(false);

    const fill = calls.find((c) => c.args[2] === 'fill');
    expect(fill?.args).toContain('--stdin');
    expect(fill?.input).toBe('Capital of France?');
    expect(calls.some((c) => c.args[2] === 'done')).toBe(true);

    const status = await backend.status('req-1');
    expect(status.submission).toBe('submitted');
    expect(status.text).toContain('Paris');
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

  it('reports connection loss after submit as unknown submission', async () => {
    let submitted = false;
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        const sub = args[2];
        if (sub === 'open' || sub === 'wait' || sub === 'fill' || sub === 'press') return ok();
        if (sub === 'eval') {
          const script = args[3] ?? '';
          if (script.includes("querySelectorAll('.prose').length")) return ok({ result: 0 });
          return ok({ result: 0 });
        }
        if (sub === 'click') {
          submitted = true;
          return ok();
        }
        if (sub === 'done') return ok();
        if (submitted) return failJson('not connected to Chrome extension relay');
        return ok();
      },
    };
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
    const out = await backend.ask({ requestId: 'req-1', prompt: 'hi' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unknown_submission');
    expect(out.failure.submission).toBe('unknown');
  });

  it('treats ambiguous click failure as unknown submission and does not press Enter', async () => {
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
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
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
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
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
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
    // Negative timeout => deadline already passed before any submit attempt.
    const out = await backend.ask({ requestId: 'req-timeout', prompt: 'hi', timeoutMs: -1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unavailable');
    expect(out.failure.submission).toBe('not_submitted');
    expect(out.failure.message).toMatch(/before the prompt was sent/);
    expect(calls).toHaveLength(0);
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
    const backend = createChromeUsePerplexityBackend({ runner, pollMs: 1, stableMs: 0 });
    const out = await backend.ask({ requestId: 'req-timeout2', prompt: 'hi', timeoutMs: 15 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('unavailable');
    expect(out.failure.submission).toBe('not_submitted');
    expect(calls.some((c) => c.args[2] === 'click')).toBe(false);
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
