import { useEffect, useLayoutEffect, useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import './SimSensorPanel.css';

/** Pad edges and sliders span ±this many degrees. */
const RANGE_DEG = 60;
/** Arrow keys nudge by this; Shift × 10. */
const NUDGE_DEG = 0.5;

/**
 * Desktop stand-in for tilting the tablet.
 *
 *   drag pad   x → roll (steer),  y → pitch (up = throttle)
 *   sliders    precise values
 *   arrows     ←/→ roll, ↑/↓ pitch  (Shift = bigger steps)
 *   dbl-click  / Centre button → back to 0, 0
 *
 * Writes straight to the fake gyro and the DOM. No React state, so dragging
 * doesn't re-render anything.
 */
export function SimSensorPanel() {
  noteRender();
  const sim = runtime.sim;

  const pad = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const rollInput = useRef<HTMLInputElement>(null);
  const pitchInput = useRef<HTMLInputElement>(null);
  const rollText = useRef<HTMLSpanElement>(null);
  const pitchText = useRef<HTMLSpanElement>(null);
  const jitterText = useRef<HTMLSpanElement>(null);

  /** Mirror the fake gyro's target into every control. */
  const paint = () => {
    const r = sim.roll;
    const p = sim.pitch;
    if (dot.current) {
      dot.current.style.left = `${50 + (clamp(r) / RANGE_DEG) * 50}%`;
      dot.current.style.top = `${50 - (clamp(p) / RANGE_DEG) * 50}%`;
    }
    if (rollInput.current) rollInput.current.value = String(r);
    if (pitchInput.current) pitchInput.current.value = String(p);
    if (rollText.current) rollText.current.textContent = fmtDeg(r);
    if (pitchText.current) pitchText.current.textContent = fmtDeg(p);
  };

  const set = (roll: number, pitch: number) => {
    sim.setRoll(roll);
    sim.setPitch(pitch);
    paint();
  };

  const fromPointer = (e: React.PointerEvent) => {
    const el = pad.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1; // -1 left … +1 right
    const y = ((e.clientY - rect.top) / rect.height) * 2 - 1; // -1 top  … +1 bottom
    set(clamp(x * RANGE_DEG), clamp(-y * RANGE_DEG)); // up = +pitch = throttle
  };

  useLayoutEffect(paint, []);

  // Arrow-key nudging, for parking the tilt at an exact value.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return; // sliders handle their own arrows
      const step = e.shiftKey ? NUDGE_DEG * 10 : NUDGE_DEG;
      let r = sim.roll;
      let p = sim.pitch;
      if (e.key === 'ArrowLeft') r -= step;
      else if (e.key === 'ArrowRight') r += step;
      else if (e.key === 'ArrowUp') p += step;
      else if (e.key === 'ArrowDown') p -= step;
      else return;
      e.preventDefault();
      set(clamp(r), clamp(p));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="sim">
      <div className="sim__head">
        <span className="sim__title">Simulated gyro</span>
        <span className="sim__hint">drag · arrows · double-click to centre</span>
      </div>

      <div
        ref={pad}
        className="sim__pad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onDoubleClick={() => set(0, 0)}
      >
        <div className="sim__axis sim__axis--x" />
        <div className="sim__axis sim__axis--y" />
        <span className="sim__edge sim__edge--l">◀ left</span>
        <span className="sim__edge sim__edge--r">right ▶</span>
        <span className="sim__edge sim__edge--t">▲ throttle</span>
        <span className="sim__edge sim__edge--b">brake ▼</span>
        <div ref={dot} className="sim__dot" />
      </div>

      <div className="sim__sliders">
        <label className="sim__slider">
          <span>Roll</span>
          <input
            ref={rollInput}
            type="range"
            min={-RANGE_DEG}
            max={RANGE_DEG}
            step={0.5}
            defaultValue={0}
            onInput={(e) => set(Number(e.currentTarget.value), sim.pitch)}
          />
          <span ref={rollText} className="mono sim__value" />
        </label>
        <label className="sim__slider">
          <span>Pitch</span>
          <input
            ref={pitchInput}
            type="range"
            min={-RANGE_DEG}
            max={RANGE_DEG}
            step={0.5}
            defaultValue={0}
            onInput={(e) => set(sim.roll, Number(e.currentTarget.value))}
          />
          <span ref={pitchText} className="mono sim__value" />
        </label>
        <label className="sim__slider">
          <span>Wobble</span>
          <input
            type="range"
            min={0}
            max={3}
            step={0.1}
            defaultValue={0.3}
            onInput={(e) => {
              const d = Number(e.currentTarget.value);
              sim.setJitter(d);
              if (jitterText.current) jitterText.current.textContent = `±${d.toFixed(1)}°`;
            }}
          />
          <span ref={jitterText} className="mono sim__value">
            ±0.3°
          </span>
        </label>
      </div>

      <button type="button" className="sim__btn" onClick={() => set(0, 0)}>
        Centre
      </button>
    </div>
  );
}

function clamp(d: number): number {
  return Math.max(-RANGE_DEG, Math.min(RANGE_DEG, d));
}

function fmtDeg(d: number): string {
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}°`;
}
