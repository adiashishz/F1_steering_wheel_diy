/**
 * Default config, built from the fieldSpecs table — never written out by hand,
 * so a default can't drift from its spec.
 */

import { FIELD_PATHS, specFor } from './fieldSpecs';
import type { AppConfig, FieldPath, FieldValue } from './schema';

export function buildDefaultConfig(): AppConfig {
  const out: Record<string, Record<string, unknown>> = {};
  for (const path of FIELD_PATHS) {
    const [section, key] = splitPath(path);
    (out[section] ??= {})[key] = specFor(path).default;
  }
  return out as unknown as AppConfig;
}

export const DEFAULT_CONFIG: Readonly<AppConfig> = deepFreeze(buildDefaultConfig());

export function defaultFor<P extends FieldPath>(path: P): FieldValue<P> {
  return specFor(path).default as FieldValue<P>;
}

/**
 * Make `v` a legal value for `path`, or return undefined if it can't be.
 *   number → must be finite, clamped to min/max
 *   bool   → must be a boolean
 *   enum   → must be one of the options
 */
export function sanitizeField<P extends FieldPath>(path: P, v: unknown): FieldValue<P> | undefined {
  const spec = specFor(path);
  if (spec.kind === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.min(Math.max(v, spec.min), spec.max) as FieldValue<P>;
  }
  if (spec.kind === 'enum') {
    return spec.options.some((o) => o.value === v) ? (v as FieldValue<P>) : undefined;
  }
  return typeof v === 'boolean' ? (v as FieldValue<P>) : undefined;
}

/** 'steering.curve' → ['steering', 'curve']. All settings are two levels deep for now. */
export function splitPath(path: FieldPath): [string, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot), path.slice(dot + 1)];
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
