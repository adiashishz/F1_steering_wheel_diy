/**
 * hotStore — a store the 100 Hz control loop can write to WITHOUT React re-rendering.
 *
 *   loop (100×/sec)  ── mutate peek(), then bump() ──►  store
 *   store ── once per screen frame, only if bumped ──►  subscribeRaf  → write DOM directly
 *   store ── N×/sec, only if bumped ──────────────────► subscribeHz   → slow readouts / React
 *
 * Rule: never hand peek() to React state. It's a live object that changes
 * under your feet; React would never see the change, or render 100×/sec.
 *
 * No React imports in core/ — this file must stay framework-free.
 */

export interface HotStore<T extends object> {
  /** The live object. The loop mutates it directly. Read-only for everyone else. */
  peek(): T;
  /** "I changed something" — schedules subscribers. Cheap; call every tick. */
  bump(): void;
  /** Increments on every bump. Lets readers skip work when nothing changed. */
  readonly version: number;
  /** Called at most once per screen frame, only after a bump. Returns unsubscribe. */
  subscribeRaf(fn: (v: Readonly<T>) => void): () => void;
  /** Called at most `hz` times a second, only after a bump. Returns unsubscribe. */
  subscribeHz(hz: number, fn: (v: Readonly<T>) => void): () => void;
}

export function createHotStore<T extends object>(initial: T): HotStore<T> {
  const value = initial;
  let version = 0;

  const rafSubs = new Set<(v: Readonly<T>) => void>();
  let frameQueued = false;

  const flushFrame = () => {
    frameQueued = false;
    for (const fn of rafSubs) fn(value);
  };

  const queueFrame = () => {
    if (frameQueued || rafSubs.size === 0) return;
    frameQueued = true;
    requestAnimationFrame(flushFrame);
  };

  return {
    peek: () => value,

    get version() {
      return version;
    },

    bump() {
      version++;
      queueFrame(); // 100 bumps/sec still means ≤ 1 flush per frame
    },

    subscribeRaf(fn) {
      rafSubs.add(fn);
      queueFrame(); // paint current values right away, don't wait for the next bump
      return () => {
        rafSubs.delete(fn);
      };
    },

    subscribeHz(hz, fn) {
      let seen = -1; // -1 → first interval always delivers
      const id = setInterval(
        () => {
          if (version === seen) return;
          seen = version;
          fn(value);
        },
        1000 / Math.max(hz, 0.1),
      );
      return () => clearInterval(id);
    },
  };
}
