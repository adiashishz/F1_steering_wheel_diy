import { useCallback, useSyncExternalStore } from 'react';
import { runtime } from '../../core/runtime';
import type { FieldPath, FieldValue } from '../../config/schema';

/**
 * One setting as React state.
 *
 *   const [curve, setCurve] = useConfigField('steering.curve');
 *
 * Re-renders ONLY when this setting changes (or on reset-all) — dragging one
 * slider doesn't re-render the others.
 */
export function useConfigField<P extends FieldPath>(path: P): [FieldValue<P>, (v: FieldValue<P>) => void] {
  const store = runtime.config;

  const subscribe = useCallback(
    (onChange: () => void) =>
      store.subscribe((_cfg, changed) => {
        if (changed === path || changed === 'all') onChange();
      }),
    [store, path],
  );

  const value = useSyncExternalStore(subscribe, () => store.getField(path));
  const set = useCallback((v: FieldValue<P>) => void store.set(path, v), [store, path]);
  return [value, set];
}
