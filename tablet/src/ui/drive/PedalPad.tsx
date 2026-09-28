import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { padDown, padUp } from '../../input/touchState';
import { useRaf } from '../hooks/useRaf';

/**
 * A big hold-to-press pad: finger down = 100%, finger up = 0. (Analog comes in piece 5.2.)
 *
 * Pointer Events + setPointerCapture: one code path for mouse and touch, and a
 * finger sliding off the pad keeps it pressed until it lifts. Released on
 * pointerup, pointercancel AND lostpointercapture — missing pointercancel is
 * the classic stuck-throttle bug.
 *
 * The lit state is painted from touchState every frame, so a release guard
 * (app switch, screen lock) visibly un-presses it too.
 */
export function PedalPad(props: { pedal: 'throttle' | 'brake' }) {
  noteRender();
  const { pedal } = props;
  const el = useRef<HTMLDivElement>(null);

  useRaf(runtime.live, () => {
    const on = runtime.touch[pedal] > 0 ? '1' : '';
    if (el.current && el.current.dataset.active !== on) el.current.dataset.active = on;
  });

  const up = (e: React.PointerEvent) => padUp(pedal, e.pointerId);

  return (
    <div
      ref={el}
      className={`pad pad--${pedal}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        padDown(pedal, e.pointerId);
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      <span className="pad__label">{pedal === 'throttle' ? 'THROTTLE' : 'BRAKE'}</span>
      <span className="pad__key mono">{pedal === 'throttle' ? 'A' : 'Z'}</span>
    </div>
  );
}
