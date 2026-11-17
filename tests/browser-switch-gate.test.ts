import { describe, expect, it } from 'vitest';
import { SwitchGate } from '../src/browser/switch-gate.js';

describe('SwitchGate', () => {
  it('refuses new sessions while it is closed', () => {
    const gate = new SwitchGate();
    expect(gate.isClosed).toBe(false);

    gate.close();
    expect(gate.isClosed).toBe(true);

    gate.open();
    expect(gate.isClosed).toBe(false);
  });

  it('counts the session creations that are running', () => {
    const gate = new SwitchGate();
    expect(gate.pendingCreations).toBe(0);

    gate.start();
    gate.start();
    expect(gate.pendingCreations).toBe(2);

    gate.finish();
    expect(gate.pendingCreations).toBe(1);

    gate.finish();
    expect(gate.pendingCreations).toBe(0);
  });

  it('waits until the running session creations are done', async () => {
    const gate = new SwitchGate();
    gate.start();
    setTimeout(() => gate.finish(), 30);

    expect(await gate.waitForIdle(1_000)).toBe(true);
    expect(gate.pendingCreations).toBe(0);
  });

  it('reports that it did not become idle after the timeout', async () => {
    const gate = new SwitchGate();
    gate.start();

    // A timeout is not an idle gate: the creation still belongs to a session
    // of another process.
    expect(await gate.waitForIdle(50)).toBe(false);
    expect(gate.pendingCreations).toBe(1);
  });
});
