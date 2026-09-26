import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { HotStore } from '../../core/hotStore';

/**
 * Read one value from a hot store into React, checked at most `hz` times a second.
 * React only re-renders when the selected value actually CHANGES.
 *
 *   const status = useHzValue(runtime.live, 2, v => v.sensorStatus);   // re-renders only on status change
 *
 * Select a primitive (string / number / boolean). Selecting an object would
 * re-render on every check.
 */
export function useHzValue<T extends object, R>(store: HotStore<T>, hz: number, select: (v: Readonly<T>) => R): R {
  const selectRef = useRef(select);
  selectRef.current = select;

  // Cache the value when the store is checked, so getSnapshot always returns
  // the same thing between checks (React requires that).
  const cached = useRef<R>(select(store.peek()));

  const subscribe = useCallback(
    (onChange: () => void) =>
      store.subscribeHz(hz, (v) => {
        const next = selectRef.current(v);
        if (!Object.is(next, cached.current)) {
          cached.current = next;
          onChange();
        }
      }),
    [store, hz],
  );

  return useSyncExternalStore(subscribe, () => cached.current);
}
