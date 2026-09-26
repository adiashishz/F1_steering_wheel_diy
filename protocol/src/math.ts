/**
 * Small pure math helpers for turning angles into control values.
 * No state, no allocation — safe to call 100×/sec, easy to port to C++.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Wrap any angle into [-180, 180). So 350° → -10°, and "left of centre" stays negative. */
export function wrapDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * Dead zone on a normalized value (-1..1). `dz` is also normalized (0..1).
 *
 *   |n| <= dz → 0                    small wobble near centre does nothing
 *   |n| >  dz → rescaled to 0..1     so there's no jump at the edge, and full lock still reaches 1
 *
 *   without rescaling:  0 0 0 0 0.10 0.11 ...   ← sudden step at the edge
 *   with rescaling:     0 0 0 0 0.00 0.01 ...   ← smooth
 */
export function applyDeadzone(n: number, dz: number): number {
  if (dz <= 0) return n;
  if (dz >= 1) return 0;
  const a = Math.abs(n);
  if (a <= dz) return 0;
  return (Math.sign(n) * (a - dz)) / (1 - dz);
}

/**
 * Response curve: sign(n) · |n|^exponent. Ends stay fixed (0→0, ±1→±1).
 *   exponent 1   → linear
 *   exponent > 1 → gentler near centre, more precision for small corrections
 *   exponent < 1 → twitchier near centre
 */
export function applyCurve(n: number, exponent: number): number {
  if (exponent <= 0 || exponent === 1) return n;
  return Math.sign(n) * Math.pow(Math.abs(n), exponent);
}

/**
 * Blend factor for exponential smoothing, based on how much time passed.
 *
 *   alpha = 1 - e^(-dt / tau)
 *
 * `tau` is a real time constant: after `tau` ms the output has moved 63% of the
 * way to a new input — whether the loop ticked every 5 ms or every 20 ms.
 * A fixed factor (like `y = y*0.9 + x*0.1`) would feel different whenever the loop lags.
 */
export function emaAlpha(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1; // no smoothing
  if (!(dtMs > 0)) return 0; // no time passed (or bad dt) → don't move
  return 1 - Math.exp(-dtMs / tauMs);
}
