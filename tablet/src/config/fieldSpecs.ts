/**
 * ONE table describing every setting. It drives three things:
 *   1. the default values   (defaults.ts)
 *   2. the allowed ranges   (configStore clamps to min/max)
 *   3. the settings sliders (piece 3.3 renders one per row)
 *
 * Adding a tunable = add it to schema.ts + one row here. The compiler errors
 * if a setting has no row, or a row has no setting.
 */

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

export type FieldSpec = NumberFieldSpec | BoolFieldSpec;

/** Numbers get a NumberFieldSpec, booleans a BoolFieldSpec — checked per path. */
type SpecFor<V> = V extends number ? NumberFieldSpec : V extends boolean ? BoolFieldSpec : never;
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
    min: 0.5, max: 3, step: 0.05, default: 1.5,
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
} as const satisfies SpecTable;

export const FIELD_PATHS = Object.keys(FIELD_SPECS) as FieldPath[];

export function specFor(path: FieldPath): FieldSpec {
  return FIELD_SPECS[path];
}
