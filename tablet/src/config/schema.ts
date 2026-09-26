/**
 * The shape of all user settings. Grows as phases land:
 *   now       steering + pitch axis tuning
 *   Phase 5+  pedals, buttons, network, mode … (extended in 8.1)
 *
 * Every leaf value MUST have a row in fieldSpecs.ts — the compiler enforces it.
 */

import type { AxisConfig } from '@wheel/protocol';

export interface AppConfig {
  /** Roll → steering. */
  steering: AxisConfig;
  /** Pitch → throttle (+) / brake (−) in gyro-pedal modes. */
  pitch: AxisConfig;
}

// ─── path helpers ───────────────────────────────────────────────────────────
// Let us name a setting by a string like 'steering.curve' and still get type checking.

/** Every leaf as a dotted path: 'steering.rangeDeg' | 'steering.curve' | … */
export type LeafPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends object ? LeafPaths<T[K], `${Prefix}${K}.`> : `${Prefix}${K}`;
}[keyof T & string];

/** The value type at a dotted path: PathValue<AppConfig, 'steering.curve'> = number. */
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? PathValue<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

export type FieldPath = LeafPaths<AppConfig>;
export type FieldValue<P extends FieldPath> = PathValue<AppConfig, P>;
