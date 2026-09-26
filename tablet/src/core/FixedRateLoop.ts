/**
 * FixedRateLoop — the steady heartbeat (default 100 Hz) that drives the controller.
 *
 * Aims every tick at a FIXED schedule (start + n × period), not "period after the
 * last one finished". So small delays don't add up:
 *
 *   naive   setTimeout(10) after each tick → 10.3, 10.3, 10.3 … ≈ 97 Hz and drifting
 *   this    next += 10; wait (next − now)  → late ticks are followed by short waits ≈ 100 Hz
 *
 * If we fall far behind (tab hidden, CPU froze), we DON'T fire a burst of
 * catch-up ticks — a burst of stale state is worse than a gap. We skip ahead,
 * count a stall, and tell the tick so it can reset smoothing.
 *
 * Not requestAnimationFrame: rAF is tied to the screen's refresh (often 60 Hz)
 * and stops entirely when the tab is hidden.
 */

export type TickFn = (now: number, dtMs: number, stalled: boolean) => void;

export interface LoopStats {
  ticks: number;
  /** Times we fell > STALL_PERIODS behind and skipped ahead. */
  stalls: number;
  /** Ticks that threw. The loop keeps running. */
  errors: number;
}

/** Fall this many periods behind → treat as a stall, not lateness. */
const STALL_PERIODS = 3;

export class FixedRateLoop {
  readonly stats: LoopStats = { ticks: 0, stalls: 0, errors: 0 };

  private readonly tick: TickFn;
  private readonly clock: () => number;
  private periodMs: number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private next = 0;
  private last = 0;

  constructor(hz: number, tick: TickFn, clock: () => number = () => performance.now()) {
    this.periodMs = 1000 / clampHz(hz);
    this.tick = tick;
    this.clock = clock;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hz(): number {
    return 1000 / this.periodMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = this.clock();
    this.last = now;
    this.next = now + this.periodMs;
    this.schedule(now);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Change rate while running. The next tick lands one new period after the last one. */
  setRate(hz: number): void {
    this.periodMs = 1000 / clampHz(hz);
    if (!this.running) return;
    this.next = this.last + this.periodMs;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.schedule(this.clock());
  }

  private schedule(now: number): void {
    this.timer = setTimeout(this.run, Math.max(0, this.next - now));
  }

  // Arrow function so it can be handed to setTimeout without allocating a closure per tick.
  private readonly run = (): void => {
    if (!this.running) return;
    const now = this.clock();

    let stalled = false;
    if (now - this.next > this.periodMs * STALL_PERIODS) {
      // Way behind. Skip ahead instead of firing a burst.
      stalled = true;
      this.stats.stalls++;
      this.next = now;
    }

    const dt = now - this.last;
    this.last = now;
    this.stats.ticks++;

    try {
      this.tick(now, dt, stalled);
    } catch (err) {
      // One bad tick must not kill the heartbeat — the safety logic lives in it.
      // Log only the first so a repeating error doesn't flood the console.
      if (this.stats.errors++ === 0) console.error('[FixedRateLoop] tick threw:', err);
    }

    this.next += this.periodMs;
    this.schedule(this.clock());
  };
}

function clampHz(hz: number): number {
  return Number.isFinite(hz) ? Math.min(Math.max(hz, 1), 250) : 100;
}
