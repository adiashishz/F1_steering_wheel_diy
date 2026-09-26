/**
 * Holds the current settings. In memory only for now — saving to the device
 * comes in Phase 8 (storage.ts plugs in here without changing this API).
 *
 *   configStore.get()                         → whole config (read-only)
 *   configStore.getField('steering.curve')    → 1.5
 *   configStore.set('steering.curve', 1.8)    → clamped, subscribers told
 *   configStore.reset('steering.curve')       → back to default (no path = reset all)
 *   configStore.subscribe(fn)                 → called after every change
 *
 * Every change makes a NEW config object (the old one is never touched), so
 *   - React can tell something changed by comparing references
 *   - the control loop can safely hold `get()` for a whole tick
 * Settings change a few times a second at most, so the copying is free.
 */

import { buildDefaultConfig, defaultFor, sanitizeField, splitPath } from './defaults';
import type { AppConfig, FieldPath, FieldValue } from './schema';

type Listener = (next: Readonly<AppConfig>, changed: FieldPath | 'all') => void;

export interface ConfigStore {
  get(): Readonly<AppConfig>;
  getField<P extends FieldPath>(path: P): FieldValue<P>;
  /** Returns false if the value was rejected (wrong type / not finite) or unchanged. */
  set<P extends FieldPath>(path: P, value: FieldValue<P>): boolean;
  reset(path?: FieldPath): void;
  subscribe(fn: Listener): () => void;
}

export function createConfigStore(initial: AppConfig = buildDefaultConfig()): ConfigStore {
  let current: Readonly<AppConfig> = initial;
  const listeners = new Set<Listener>();

  const read = (cfg: Readonly<AppConfig>, path: FieldPath): unknown => {
    const [section, key] = splitPath(path);
    return (cfg as unknown as Record<string, Record<string, unknown>>)[section]?.[key];
  };

  const write = (path: FieldPath, value: unknown) => {
    const [section, key] = splitPath(path);
    const cfg = current as unknown as Record<string, Record<string, unknown>>;
    // Copy just the two objects on the path; everything else is shared.
    current = { ...cfg, [section]: { ...cfg[section], [key]: value } } as unknown as AppConfig;
  };

  const emit = (changed: FieldPath | 'all') => {
    for (const fn of listeners) fn(current, changed);
  };

  return {
    get: () => current,

    getField: (path) => read(current, path) as FieldValue<typeof path>,

    set(path, value) {
      const clean = sanitizeField(path, value);
      if (clean === undefined) return false;
      if (Object.is(read(current, path), clean)) return false;
      write(path, clean);
      emit(path);
      return true;
    },

    reset(path) {
      if (path) {
        if (Object.is(read(current, path), defaultFor(path))) return;
        write(path, defaultFor(path));
        emit(path);
      } else {
        current = buildDefaultConfig();
        emit('all');
      }
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
