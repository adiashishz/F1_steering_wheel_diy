import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { padDown, padMove, padUp, pedalLevel } from '../../input/touchState';
import { useRaf } from '../hooks/useRaf';

/**
 * A big analog pad, like L2 / R2: finger height = how far the trigger is pulled
 * (bottom = light, top part = 100%, see pedalLevel), and sliding changes it live.
 * The fill and the % show what's being sent.
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

  const pct = useRef<HTMLSpanElement>(null);
  const shown = useRef(-1);
  useRaf(runtime.live, () => {
    const level = runtime.touch[pedal];
    if (!el.current || level === shown.current) return;
    shown.current = level;
    el.current.dataset.active = level > 0 ? '1' : '';
    el.current.style.setProperty('--level', String(level));
    if (pct.current) pct.current.textContent = level > 0 ? `${Math.round(level * 100)}%` : '';
  });

  const levelAt = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return pedalLevel((r.bottom - e.clientY) / r.height);
  };

  // Every pedal touch goes to the bridge log — to catch phantom touches from the screen.
  const downAt = useRef(new Map<number, number>());
  const report = (what: string, e: React.PointerEvent) => {
    const t0 = downAt.current.get(e.pointerId);
    const held = what.startsWith('down') || t0 === undefined ? '' : ` held ${Math.round(performance.now() - t0)} ms`;
    runtime.esp.debug(
      `${pedal} ${what} · ptr ${e.pointerId} ${e.pointerType} · at ${Math.round(e.clientX)},${Math.round(e.clientY)} ` +
        `of ${innerWidth}×${innerHeight} · contact ${e.width.toFixed(0)}×${e.height.toFixed(0)} · pressure ${e.pressure.toFixed(2)}${held}`,
    );
  };
  const up = (e: React.PointerEvent) => {
    padUp(pedal, e.pointerId); // release FIRST, always — logging must never gate it
    if (!downAt.current.has(e.pointerId)) return; // already reported (up + lostpointercapture both fire)
    report(e.type.replace('pointer', '').replace('lostpointercapture', 'lost-capture'), e);
    downAt.current.delete(e.pointerId);
  };

  return (
    <div
      ref={el}
      className={`pad pad--${pedal}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        downAt.current.set(e.pointerId, performance.now());
        const level = levelAt(e);
        padDown(pedal, e.pointerId, level);
        report(`down ${Math.round(level * 100)}%`, e);
      }}
      onPointerMove={(e) => padMove(pedal, e.pointerId, levelAt(e))}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      <span className="pad__label">{pedal === 'throttle' ? 'THROTTLE' : 'BRAKE'}</span>
      <span ref={pct} className="pad__key mono" />
    </div>
  );
}
