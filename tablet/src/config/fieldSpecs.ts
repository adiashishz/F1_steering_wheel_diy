/**
 * ONE table describing every setting. It drives three things:
 *   1. the default values   (defaults.ts)
 *   2. the allowed ranges   (configStore clamps to min/max)
 *   3. the settings sliders (piece 3.3 renders one per row)
 *
 * Adding a tunable = add it to schema.ts + one row here. The compiler errors
 * if a setting has no row, or a row has no setting.
 */

import { STEER_PULSE_LIMITS } from '@wheel/protocol';
import type { FieldPath, FieldValue } from './schema';

export interface NumberFieldSpec {
  kind: 'number';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** One line shown under the slider. */
  help?: string;
}

export interface BoolFieldSpec {
  kind: 'bool';
  label: string;
  default: boolean;
  help?: string;
}

/** Pick one of a fixed list of strings. */
export interface EnumFieldSpec {
  kind: 'enum';
  label: string;
  options: readonly { value: string; label: string }[];
  default: string;
  help?: string;
}

export type FieldSpec = NumberFieldSpec | BoolFieldSpec | EnumFieldSpec;

/** Numbers get a NumberFieldSpec, booleans a BoolFieldSpec, string unions an EnumFieldSpec — checked per path. */
type SpecFor<V> = [V] extends [number]
  ? NumberFieldSpec
  : [V] extends [boolean]
    ? BoolFieldSpec
    : [V] extends [string]
      ? EnumFieldSpec
      : never;
type SpecTable = { [P in FieldPath]: SpecFor<FieldValue<P>> };

export const FIELD_SPECS = {
  // ─── steering (roll) ── starting values from plan.md §9 ────────────────────
  'steering.rangeDeg': {
    kind: 'number', label: 'Steering range', unit: '°',
    min: 10, max: 90, step: 1, default: 45,
    help: 'Tilt that maps to full lock (before sensitivity).',
  },
  'steering.deadzoneDeg': {
    kind: 'number', label: 'Dead zone', unit: '°',
    min: 0, max: 15, step: 0.5, default: 3,
    help: 'Tilt around centre that counts as straight.',
  },
  'steering.sensitivity': {
    kind: 'number', label: 'Sensitivity', unit: '×',
    min: 0.5, max: 3, step: 0.05, default: 1.3,
    help: 'Higher reaches full lock with less tilt.',
  },
  'steering.curve': {
    kind: 'number', label: 'Response curve', unit: '',
    // 1.0 since the DualSense route (2026-09-29): the stick is truly analog and
    // F1 25 shapes it again; 1.5 was for the on/off keyboard keys.
    min: 0.5, max: 3, step: 0.05, default: 1,
    help: '1 = linear. Higher = gentler near centre, sharper near lock.',
  },
  'steering.smoothingMs': {
    kind: 'number', label: 'Smoothing', unit: 'ms',
    min: 0, max: 200, step: 1, default: 20,
    help: 'Removes wobble. Adds roughly this much delay.',
  },
  'steering.invert': {
    kind: 'bool', label: 'Invert steering', default: false,
  },

  // ─── pitch (gyro pedals) ── plan.md §10: ±30°, 5° neutral zone ─────────────
  'pitch.rangeDeg': {
    kind: 'number', label: 'Pedal tilt range', unit: '°',
    min: 10, max: 60, step: 1, default: 30,
    help: 'Tilt forward/back that maps to full throttle/brake.',
  },
  'pitch.deadzoneDeg': {
    kind: 'number', label: 'Neutral zone', unit: '°',
    min: 0, max: 15, step: 0.5, default: 5,
    help: 'Tilt around centre where neither pedal is pressed.',
  },
  'pitch.sensitivity': {
    kind: 'number', label: 'Sensitivity', unit: '×',
    min: 0.5, max: 3, step: 0.05, default: 1,
  },
  'pitch.curve': {
    kind: 'number', label: 'Response curve', unit: '',
    min: 0.5, max: 3, step: 0.05, default: 1,
  },
  'pitch.smoothingMs': {
    kind: 'number', label: 'Smoothing', unit: 'ms',
    min: 0, max: 200, step: 1, default: 30,
  },
  'pitch.invert': {
    kind: 'bool', label: 'Invert pedals', default: false,
  },

  // ─── pedal source ──────────────────────────────────────────────────────────
  'pedals.gyro': {
    kind: 'bool', label: 'Gyro pedals (pitch)', default: false,
    help: 'Off: throttle / brake come only from the touch pads.',
  },

  // ─── steer keys — the live lock test (limits shared with the ESP32) ────────
  'steerOutput.mode': {
    kind: 'enum', label: 'Steer keys',
    options: [
      { value: 'hold', label: 'Hold' },
      { value: 'pwm', label: 'PWM' },
      { value: 'sigma', label: 'Sigma' },
    ],
    // PWM by default while the lock test is what this build is for.
    default: 'pwm',
    help: 'Hold = on/off (full lock). PWM / Sigma pulse the key to try for part-way lock.',
  },
  'steerOutput.periodMs': {
    kind: 'number', label: 'PWM period', unit: 'ms',
    min: STEER_PULSE_LIMITS.periodMs.min, max: STEER_PULSE_LIMITS.periodMs.max, step: 5, default: 40,
    help: 'One on + off cycle. Shorter = less shake, if the game keeps up.',
  },
  'steerOutput.minPulseMs': {
    kind: 'number', label: 'Shortest press / gap', unit: 'ms',
    min: STEER_PULSE_LIMITS.minPulseMs.min, max: 50, step: 1, default: 10,
    help: 'Pulses shorter than a game frame (~17 ms at 60 fps) may be missed.',
  },
  'steerOutput.fullAt': {
    kind: 'number', label: 'Solid hold from', unit: '',
    min: STEER_PULSE_LIMITS.fullAt.min, max: STEER_PULSE_LIMITS.fullAt.max, step: 0.01, default: 0.95,
    help: 'Steering at or past this gets full duty. Duty = steering ÷ this.',
  },
  'steerOutput.maxDuty': {
    kind: 'number', label: 'Max duty', unit: '',
    min: STEER_PULSE_LIMITS.maxDuty.min, max: STEER_PULSE_LIMITS.maxDuty.max, step: 0.01, default: 1,
    help: 'Key-on share at full tilt. Lower it if the wheel still pins to full lock.',
  },
} as const satisfies SpecTable;

export const FIELD_PATHS = Object.keys(FIELD_SPECS) as FieldPath[];

export function specFor(path: FieldPath): FieldSpec {
  return FIELD_SPECS[path];
}
