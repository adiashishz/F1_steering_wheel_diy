import { useEffect, useRef, useState } from 'react';
import { runtime } from '../../core/runtime';
import type { LiveState } from '../../core/ControlLoop';
import { noteRender } from '../../core/telemetry';
import './AxisScope.css';

type Axis = 'steering' | 'pedals';

/** How much history the graph shows. */
const WINDOW_MS = 2000;
/** Ring buffer size: 2 s at up to 120 fps, with room to spare. */
const CAPACITY = 300;
/** Vertical range: a bit past ±1 so full lock isn't glued to the edge. */
const Y_MAX = 1.2;

/** Which LiveState fields each tab plots. */
const PICK: Record<Axis, { raw: (v: LiveState) => number; shaped: (v: LiveState) => number; out: (v: LiveState) => number }> = {
  steering: { raw: (v) => v.steeringRaw, shaped: (v) => v.steeringShaped, out: (v) => v.steering },
  pedals: { raw: (v) => v.pedalTiltRaw, shaped: (v) => v.pedalTiltShaped, out: (v) => v.pedalTilt },
};

/**
 * Live 2-second graph of one axis — see what the tuning actually does.
 *
 *   grey  = raw tilt ÷ range        what your hand did
 *   blue  = shaped                  after dead zone / sensitivity / curve
 *   white = final output            after smoothing — what gets sent
 *   band  = dead zone
 *
 * Samples are taken once per screen frame into fixed-size typed arrays and the
 * canvas is redrawn in the same frame. The component renders once; switching
 * the tab is the only React update.
 */
export function AxisScope() {
  noteRender();
  const [axis, setAxis] = useState<Axis>('steering');
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    // Ring buffers. Cleared when the tab changes (this effect re-runs).
    const t = new Float64Array(CAPACITY);
    const raw = new Float32Array(CAPACITY);
    const shaped = new Float32Array(CAPACITY);
    const out = new Float32Array(CAPACITY);
    let head = 0; // next write slot
    let count = 0;

    const pick = PICK[axis];
    const section = axis === 'steering' ? 'steering' : 'pitch';

    // Colours from the design tokens, read once.
    const css = getComputedStyle(document.documentElement);
    const color = {
      grid: css.getPropertyValue('--border').trim() || '#232c3a',
      band: 'rgba(245, 158, 11, 0.10)', // --warn, faint
      raw: css.getPropertyValue('--text-dim').trim() || '#5b6676',
      shaped: css.getPropertyValue('--info').trim() || '#38bdf8',
      out: css.getPropertyValue('--text').trim() || '#e6edf7',
    };

    // Keep the canvas pixel size in step with its CSS size (sharp on HiDPI).
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const yOf = (n: number) => h / 2 - (Math.max(-Y_MAX, Math.min(Y_MAX, n)) / Y_MAX) * (h / 2);

    const line = (buf: Float32Array, stroke: string, width: number, now: number) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < count; i++) {
        const k = (head - count + i + CAPACITY) % CAPACITY;
        const x = w - ((now - t[k]!) / WINDOW_MS) * w;
        const y = yOf(buf[k]!);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    const draw = (v: Readonly<LiveState>) => {
      const now = performance.now();

      // 1. record this frame's sample
      t[head] = now;
      raw[head] = pick.raw(v);
      shaped[head] = pick.shaped(v);
      out[head] = pick.out(v);
      head = (head + 1) % CAPACITY;
      if (count < CAPACITY) count++;
      // drop samples older than the window
      while (count > 1 && now - t[(head - count + CAPACITY) % CAPACITY]! > WINDOW_MS) count--;

      // 2. background: dead-zone band, zero line, ±1 lines
      ctx.clearRect(0, 0, w, h);
      const cfg = runtime.config.get()[section];
      const dz = cfg.deadzoneDeg / (cfg.rangeDeg || 1);
      ctx.fillStyle = color.band;
      ctx.fillRect(0, yOf(dz), w, yOf(-dz) - yOf(dz));

      ctx.strokeStyle = color.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const g of [-1, 0, 1]) {
        const y = Math.round(yOf(g)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // 3. the three lines, back to front
      line(raw, color.raw, 1.5, now);
      line(shaped, color.shaped, 1.5, now);
      line(out, color.out, 2, now);
    };

    const unsubscribe = runtime.live.subscribeRaf(draw);
    return () => {
      unsubscribe();
      ro.disconnect();
    };
  }, [axis]);

  return (
    <div className="scope">
      <div className="scope__head">
        <div className="scope__tabs" role="tablist">
          {(['steering', 'pedals'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={a === axis}
              className="scope__tab"
              onClick={() => setAxis(a)}
            >
              {a === 'steering' ? 'Steering' : 'Pedals'}
            </button>
          ))}
        </div>
        <div className="scope__legend">
          <span className="scope__key scope__key--raw">raw tilt</span>
          <span className="scope__key scope__key--shaped">shaped</span>
          <span className="scope__key scope__key--out">sent</span>
          <span className="scope__key scope__key--band">dead zone</span>
        </div>
      </div>
      <div className="scope__plot">
        <canvas ref={canvas} className="scope__canvas" />
        <span className="scope__label scope__label--top">+1</span>
        <span className="scope__label scope__label--mid">0</span>
        <span className="scope__label scope__label--bot">−1</span>
        <span className="scope__label scope__label--time">← 2 s</span>
      </div>
    </div>
  );
}
