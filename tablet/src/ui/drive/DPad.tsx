import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { buttonDown, buttonUp } from '../../input/touchState';
import { useRaf } from '../hooks/useRaf';

type Dir = 'up' | 'down' | 'left' | 'right';

const ACTION: Record<Dir, string> = { up: 'dpadUp', down: 'dpadDown', left: 'dpadLeft', right: 'dpadRight' };

/** Inside this fraction of the pad's radius nothing is pressed — rest your thumb in the middle. */
const DEAD_CENTRE = 0.22;

/**
 * One cross-shaped D-pad, like a controller's: where the finger IS picks the
 * direction, so you can slide up → right → down without lifting. 4-way (menus
 * don't want diagonals).
 *
 *   pointerdown / move → angle from centre → press that arm (release the old one)
 *   pointerup / cancel / lost capture → release
 *
 * The lit arm is painted from touchState each frame, so a release guard
 * (app switch, screen lock) visibly un-presses it too. No React state.
 */
export function DPad() {
  noteRender();
  const el = useRef<HTMLDivElement>(null);
  const held = useRef<{ pointer: number; dir: Dir | null } | null>(null);

  useRaf(runtime.live, () => {
    const b = runtime.touch.buttons;
    const dir = b.dpadUp ? 'up' : b.dpadDown ? 'down' : b.dpadLeft ? 'left' : b.dpadRight ? 'right' : '';
    if (el.current && el.current.dataset.dir !== dir) el.current.dataset.dir = dir;
  });

  const dirAt = (e: React.PointerEvent): Dir | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    if (Math.hypot(dx, dy) < DEAD_CENTRE) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  };

  const set = (pointer: number, dir: Dir | null) => {
    const cur = held.current?.dir ?? null;
    if (cur === dir) return;
    if (cur) buttonUp(ACTION[cur], pointer);
    if (dir) {
      buttonDown(ACTION[dir], pointer);
      navigator.vibrate?.(8); // a tick per direction, where supported (Android)
    }
    held.current = { pointer, dir };
  };

  const end = (e: React.PointerEvent) => {
    if (held.current?.pointer !== e.pointerId) return;
    set(e.pointerId, null);
    held.current = null;
  };

  return (
    <div
      ref={el}
      className="dpad"
      onPointerDown={(e) => {
        if (held.current) return; // one thumb at a time
        e.currentTarget.setPointerCapture(e.pointerId);
        set(e.pointerId, dirAt(e));
      }}
      onPointerMove={(e) => {
        if (held.current?.pointer === e.pointerId) set(e.pointerId, dirAt(e));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      {/* two bars, one shadow: the filter on the wrapper draws around their union, so no seam */}
      <div className="dpad__shape">
        <div className="dpad__bar dpad__bar--v" />
        <div className="dpad__bar dpad__bar--h" />
      </div>
      <span className="dpad__arm dpad__arm--up">▲</span>
      <span className="dpad__arm dpad__arm--down">▼</span>
      <span className="dpad__arm dpad__arm--left">◀</span>
      <span className="dpad__arm dpad__arm--right">▶</span>
      <span className="dpad__hub" />
    </div>
  );
}
