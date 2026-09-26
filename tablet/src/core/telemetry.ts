/**
 * Small counters for the debug panel. Built for the hot path:
 * mark() is a couple of arithmetic ops and never allocates.
 * The heavier summary() is meant for the UI to call a few times a second.
 */

/**
 * Events per second, measured over a rolling window.
 *
 *   loopRate.mark(now)       ← every tick
 *   loopRate.read(now)       → ~100
 *
 * read() drops to 0 if marks stop, so a dead loop never shows a stale "100 Hz".
 */
export class RateMeter {
  private hz = 0;
  private count = 0;
  private windowStart = NaN;
  private lastMark = NaN;
  private readonly windowMs: number;

  constructor(windowMs = 500) {
    this.windowMs = windowMs;
  }

  mark(now: number): void {
    this.lastMark = now;
    // First mark only opens the window: N marks after it = N intervals.
    if (Number.isNaN(this.windowStart)) {
      this.windowStart = now;
      return;
    }
    this.count++;
    const elapsed = now - this.windowStart;
    if (elapsed >= this.windowMs) {
      this.hz = (this.count * 1000) / elapsed;
      this.count = 0;
      this.windowStart = now;
    }
  }

  read(now: number): number {
    if (Number.isNaN(this.lastMark) || now - this.lastMark > this.windowMs * 2) return 0;
    return this.hz;
  }

  reset(): void {
    this.hz = 0;
    this.count = 0;
    this.windowStart = NaN;
    this.lastMark = NaN;
  }
}

export interface IntervalSummary {
  /** Samples in the buffer. */
  count: number;
  mean: number;
  /** 99% of intervals were at or below this. The "how bad does it get" number. */
  p99: number;
  max: number;
}

/**
 * Remembers the last N time gaps (e.g. between loop ticks) so we can see jitter.
 *
 *   ticks.mark(now)          ← every tick; records the gap since the previous mark
 *   ticks.summary()          → { mean: 10.0, p99: 12.4, max: 16.1 }
 */
export class IntervalStats {
  private readonly buf: Float64Array;
  private size = 0;
  private next = 0;
  private last = NaN;

  constructor(capacity = 256) {
    this.buf = new Float64Array(capacity);
  }

  mark(now: number): void {
    if (!Number.isNaN(this.last)) this.push(now - this.last);
    this.last = now;
  }

  /** Record a value directly (e.g. a measured latency). */
  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.buf.length;
    if (this.size < this.buf.length) this.size++;
  }

  /** Allocates a sorted copy — call from the UI a few times a second, not from the loop. */
  summary(): IntervalSummary {
    if (this.size === 0) return { count: 0, mean: 0, p99: 0, max: 0 };
    const sorted = this.buf.slice(0, this.size).sort();
    let sum = 0;
    for (const v of sorted) sum += v;
    return {
      count: this.size,
      mean: sum / this.size,
      p99: sorted[Math.min(this.size - 1, Math.floor(this.size * 0.99))]!,
      max: sorted[this.size - 1]!,
    };
  }

  reset(): void {
    this.size = 0;
    this.next = 0;
    this.last = NaN;
  }
}

/**
 * Dev-only React render counter. Components on the drive screen call
 * noteRender() in their body; the debug panel shows the total.
 * If it keeps climbing while you're just driving, something is re-rendering at loop speed.
 */
export const renderStats = { count: 0 };

export function noteRender(): void {
  if (import.meta.env.DEV) renderStats.count++;
}
