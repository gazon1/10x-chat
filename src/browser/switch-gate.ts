/**
 * The barrier between "the daemon is switching" and "the daemon serves
 * sessions".
 *
 * While the gate is closed the daemon refuses new sessions. A switch closes
 * the gate, waits for the session creations that are already running and then
 * checks how much work is left: a session that started in the meantime is
 * visible then, and the switch is refused instead of taking the browser away
 * from that session.
 */
export class SwitchGate {
  private closed = false;
  private pending = 0;

  /** Whether new sessions are refused. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The session creations that are still running. */
  get pendingCreations(): number {
    return this.pending;
  }

  /** Close the gate: new sessions are refused. */
  close(): void {
    this.closed = true;
  }

  /** Open the gate again: new sessions are allowed. */
  open(): void {
    this.closed = false;
  }

  /** A session creation has started. */
  start(): void {
    this.pending += 1;
  }

  /** A session creation has ended. */
  finish(): void {
    this.pending = Math.max(0, this.pending - 1);
  }

  /**
   * Wait until the session creations that are running are done.
   *
   * @returns `true` when the gate is idle, `false` when the timeout was
   * reached and a creation is still running. A timeout is not an "idle"
   * gate: the creation that runs belongs to a session that must not lose
   * its browser.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.pending === 0;
  }
}
