import { useRef } from 'react';
import { noteRender } from '../../core/telemetry';

/**
 * What does this screen report about a finger? Press and hold, then press harder.
 *
 *   pressure   0 … 1. Stuck at 0.5 → the screen has no pressure sensing (the spec's default)
 *   contact    width × height in CSS px. Grows when a fingertip flattens → a usable pressure proxy
 *
 * Shows the min / max seen, so "does it change at all?" is one glance. Diagnostic only.
 */
export function TouchProbe() {
  noteRender();
  const out = useRef<HTMLPreElement>(null);
  const seen = useRef({ pMin: Infinity, pMax: -Infinity, aMin: Infinity, aMax: -Infinity, n: 0 });

  const show = (e: React.PointerEvent) => {
    const s = seen.current;
    const area = e.width * e.height;
    s.pMin = Math.min(s.pMin, e.pressure);
    s.pMax = Math.max(s.pMax, e.pressure);
    s.aMin = Math.min(s.aMin, area);
    s.aMax = Math.max(s.aMax, area);
    s.n++;
    if (!out.current) return;
    out.current.textContent =
      `type      ${e.pointerType}\n` +
      `pressure  ${e.pressure.toFixed(3)}    (seen ${s.pMin.toFixed(3)} … ${s.pMax.toFixed(3)})\n` +
      `contact   ${e.width.toFixed(1)} × ${e.height.toFixed(1)} px  (area seen ${s.aMin.toFixed(0)} … ${s.aMax.toFixed(0)})\n` +
      `samples   ${s.n}\n` +
      verdict(s);
  };

  return (
    <div className="probe">
      <h3 className="telemetry__title">Touch test — press, hold, then press harder</h3>
      <div
        className="probe__pad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          show(e);
        }}
        onPointerMove={show}
        onDoubleClick={() => {
          seen.current = { pMin: Infinity, pMax: -Infinity, aMin: Infinity, aMax: -Infinity, n: 0 };
          if (out.current) out.current.textContent = 'reset — press again';
        }}
      >
        <pre ref={out} className="probe__out mono">
          press here (double-tap to reset)
        </pre>
      </div>
    </div>
  );
}

function verdict(s: { pMin: number; pMax: number; aMin: number; aMax: number; n: number }): string {
  if (s.n < 20) return 'keep pressing…';
  const pressure = s.pMax - s.pMin > 0.05;
  const area = s.aMax > s.aMin * 1.3 && s.aMax > 4;
  if (pressure) return '→ REAL PRESSURE: usable for analog pedals';
  if (area) return '→ no pressure, but contact size changes: usable as a rough proxy';
  return '→ neither changes: use finger position for analog pedals';
}
