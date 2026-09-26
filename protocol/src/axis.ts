/**
 * AxisProcessor — turns a raw tilt angle into a clean -1..1 control value.
 * One instance per axis: roll → steering, pitch → pedals.
 *
 *   rawDeg ─► centre ─► ÷range ─► deadzone ─► ×sensitivity ─► clamp ─► curve ─► smooth ─► invert ─► -1..1
 *
 * Why this order:
 *   deadzone before curve   → the curve can't squash the dead-zone edge into a visible step
 *   sensitivity before clamp → sensitivity means "reach full lock sooner"
 *   curve after clamp       → curve only ever sees -1..1, so the ends stay fixed
 *   smoothing last          → we smooth the value we actually send
 */

import { applyCurve, applyDeadzone, clamp, emaAlpha, wrapDeg } from './math';

export interface AxisConfig {
  /** Degrees of tilt that map to full output (before sensitivity). */
  rangeDeg: number;
  /** Degrees around centre that count as zero. */
  deadzoneDeg: number;
  /** >1 reaches full output with less tilt. */
  sensitivity: number;
  /** Response curve exponent. 1 = linear, >1 = gentler near centre. */
  curve: number;
  /** Smoothing time constant in ms. 0 = off. Also adds roughly this much lag. */
  smoothingMs: number;
  /** Flip direction. */
  invert: boolean;
}

/**
 * Frame-rate independent exponential smoother.
 * Also used on its own for touch pedals.
 */
export class Ema {
  value: number;
  private primed: boolean;

  /** With an initial value it starts there; without one, the first step snaps to its input. */
  constructor(initial?: number) {
    this.value = initial ?? 0;
    this.primed = initial !== undefined;
  }

  step(x: number, dtMs: number, tauMs: number): number {
    if (!this.primed) {
      this.value = x;
      this.primed = true;
      return x;
    }
    this.value += emaAlpha(dtMs, tauMs) * (x - this.value);
    return this.value;
  }

  /** Next step snaps straight to its input instead of gliding from the old value. */
  reset(): void {
    this.primed = false;
  }
}

export class AxisProcessor {
  config: AxisConfig;

  /** Final output, -1..1. */
  value = 0;
  /** Output before smoothing. Useful for the tuning graph. */
  shaped = 0;
  /** Last raw angle after centring, in degrees. */
  centeredDeg = 0;

  private readonly ema = new Ema();
  private center = 0;

  constructor(config: AxisConfig) {
    this.config = config;
  }

  /** Calibrated centre in degrees. 0 until calibrated. */
  get centerDeg(): number {
    return this.center;
  }

  /** Set a new centre. Also clears smoothing, so steering jumps to the new zero instead of gliding. */
  setCenter(deg: number): void {
    this.center = deg;
    this.ema.reset();
  }

  process(rawDeg: number, dtMs: number): number {
    // A bad sensor reading must never reach the output. Hold the last good value.
    if (!Number.isFinite(rawDeg)) return this.value;

    const c = this.config;
    const range = c.rangeDeg > 0 ? c.rangeDeg : 1;

    this.centeredDeg = wrapDeg(rawDeg - this.center);

    let n = this.centeredDeg / range; //    45° of tilt → 1.0
    n = applyDeadzone(n, c.deadzoneDeg / range); // small wobble → 0
    n = n * c.sensitivity; //               reach full lock sooner
    n = clamp(n, -1, 1);
    n = applyCurve(n, c.curve); //          gentler near centre
    this.shaped = n;

    n = this.ema.step(n, dtMs, c.smoothingMs);
    n = clamp(n, -1, 1);
    if (c.invert) n = -n;

    this.value = n;
    return n;
  }

  /**
   * Forget smoothing history. The next process() snaps to the current input.
   * Call on mode change or sensor switch (setCenter already does it) — so
   * steering never glides over from where it used to be.
   */
  reset(): void {
    this.ema.reset();
  }
}
