// A screen wake lock, held while auto-grind plays, where the browser supports it.

type Sentinel = { release: () => Promise<void> };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

export class ScreenWake {
  private lock: Sentinel | null = null;

  async set(on: boolean): Promise<void> {
    try {
      if (on && !this.lock) {
        const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
        this.lock = (await api?.request('screen')) ?? null;
      } else if (!on && this.lock) {
        const lock = this.lock;
        this.lock = null;
        await lock.release();
      }
    } catch {
      this.lock = null;
    }
  }

  /** The browser drops wake locks when the page hides: take it again. */
  reacquire(): void {
    this.lock = null;
    void this.set(true);
  }
}
