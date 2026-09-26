import { useEffect, useLayoutEffect, useRef } from 'react';
import type { HotStore } from '../../core/hotStore';

/**
 * Run `fn` once per screen frame when the store changed — for writing to the DOM
 * directly (textContent, style). NEVER causes a React render.
 *
 *   const el = useRef<HTMLSpanElement>(null);
 *   useRaf(runtime.live, v => { el.current!.textContent = v.roll.toFixed(1); });
 */
export function useRaf<T extends object>(store: HotStore<T>, fn: (v: Readonly<T>) => void): void {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => store.subscribeRaf((v) => fnRef.current(v)), [store]);
}
