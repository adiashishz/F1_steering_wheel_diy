import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import type { LiveState } from '../../core/ControlLoop';
import { noteRender, renderStats } from '../../core/telemetry';
import { useRaf } from '../hooks/useRaf';
import './TelemetryPanel.css';

type Tone = 'ok' | 'warn' | 'bad' | '';

interface Row {
  label: string;
  text: (v: LiveState) => string;
  tone?: (v: LiveState) => Tone;
}

/** A bar that fills left/right from the centre. `value` returns −1..1. */
interface Bar {
  label: string;
  value: (v: LiveState) => number;
  color?: string;
  /** Colour when the value is negative. Defaults to `color`. */
  negColor?: string;
}

interface Group {
  title: string;
  rows: Row[];
  bars?: Bar[];
}

/** Tilt bars span ±this many degrees. */
const TILT_BAR_DEG = 60;

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const deg = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}°`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`;
/** Pedal tilt: + is throttle, − is brake. */
const pedal = (n: number) => (n > 0 ? `thr ${(n * 100).toFixed(0)}%` : n < 0 ? `brk ${(-n * 100).toFixed(0)}%` : '—');

const GROUPS: Group[] = [
  {
    title: 'Loop',
    rows: [
      { label: 'Rate', text: (v) => `${f1(v.loopHz)} Hz`, tone: (v) => (v.loopHz >= 95 ? 'ok' : v.loopHz >= 60 ? 'warn' : 'bad') },
      { label: 'Tick gap', text: (v) => `${f2(v.tickMeanMs)} ms` },
      { label: 'Gap p99', text: (v) => `${f2(v.tickP99Ms)} ms`, tone: (v) => (v.tickP99Ms <= 15 ? 'ok' : 'warn') },
      { label: 'Stalls', text: (v) => String(v.stalls), tone: (v) => (v.stalls === 0 ? '' : 'warn') },
      { label: 'Errors', text: (v) => String(v.errors), tone: (v) => (v.errors === 0 ? '' : 'bad') },
    ],
  },
  {
    title: 'Sensor',
    rows: [
      { label: 'Source', text: (v) => v.sensorId || '—' },
      { label: 'Status', text: (v) => v.sensorStatus, tone: (v) => (v.sensorStatus === 'live' ? 'ok' : 'warn') },
      { label: 'Rate', text: (v) => `${f1(v.sensorHz)} Hz` },
      { label: 'Fresh', text: (v) => (v.sensorFresh ? `yes · ${f1(v.sensorAgeMs)} ms` : 'no'), tone: (v) => (v.sensorFresh ? 'ok' : 'bad') },
    ],
  },
  {
    title: 'Tilt (raw)',
    rows: [
      { label: 'Roll', text: (v) => deg(v.roll) },
      { label: 'Pitch', text: (v) => deg(v.pitch) },
    ],
    bars: [
      { label: 'R', value: (v) => v.roll / TILT_BAR_DEG },
      { label: 'P', value: (v) => v.pitch / TILT_BAR_DEG },
    ],
  },
  {
    title: 'Control',
    rows: [
      { label: 'Steering', text: (v) => signed(v.steering), tone: (v) => (Math.abs(v.steering) >= 0.999 ? 'warn' : '') },
      { label: 'Pedal tilt', text: (v) => pedal(v.pedalTilt) },
    ],
    bars: [
      { label: 'S', value: (v) => v.steering, color: 'var(--text)' },
      // Throttle green to the right, brake red to the left.
      { label: 'T', value: (v) => v.pedalTilt, color: 'var(--go)', negColor: 'var(--accent)' },
    ],
  },
];

/**
 * Live numbers for debugging. Every value is written straight to the DOM once
 * per frame — this component renders ONCE and then never again.
 */
export function TelemetryPanel() {
  noteRender();

  const cells = useRef<(HTMLElement | null)[]>([]);
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const renders = useRef<HTMLElement>(null);

  useRaf(runtime.live, (v) => {
    let i = 0;
    let b = 0;
    for (const g of GROUPS) {
      for (const r of g.rows) {
        const el = cells.current[i++];
        if (!el) continue;
        const text = r.text(v);
        if (el.textContent !== text) el.textContent = text;
        const tone = r.tone ? r.tone(v) : '';
        if (el.dataset.tone !== tone) el.dataset.tone = tone;
      }
      if (g.bars) for (const bar of g.bars) setBar(bars.current[b++] ?? null, bar.value(v));
    }
    if (renders.current) renders.current.textContent = String(renderStats.count);
  });

  let cellIndex = 0;
  let barIndex = 0;
  return (
    <div className="telemetry">
      {GROUPS.map((g) => (
        <section key={g.title} className="telemetry__group">
          <h3 className="telemetry__title">{g.title}</h3>
          <dl className="telemetry__rows">
            {g.rows.map((r) => {
              const i = cellIndex++;
              return (
                <div key={r.label} className="telemetry__row">
                  <dt>{r.label}</dt>
                  <dd
                    className="mono"
                    ref={(el) => {
                      cells.current[i] = el;
                    }}
                  >
                    —
                  </dd>
                </div>
              );
            })}
          </dl>
          {g.bars && (
            <div className="telemetry__bars">
              {g.bars.map((bar) => {
                const i = barIndex++;
                return (
                  <CenterBar
                    key={bar.label}
                    label={bar.label}
                    color={bar.color}
                    negColor={bar.negColor}
                    barRef={(el) => {
                      bars.current[i] = el;
                    }}
                  />
                );
              })}
            </div>
          )}
        </section>
      ))}

      <section className="telemetry__group">
        <h3 className="telemetry__title">UI</h3>
        <dl className="telemetry__rows">
          <div className="telemetry__row" title="Should stop climbing once the page has loaded. If it keeps rising, something re-renders at loop speed.">
            <dt>React renders</dt>
            <dd className="mono" ref={renders}>
              —
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function CenterBar(props: {
  label: string;
  color?: string | undefined;
  negColor?: string | undefined;
  barRef: React.Ref<HTMLDivElement>;
}) {
  const style: Record<string, string> = {};
  if (props.color) style['--bar-color'] = props.color;
  if (props.negColor) style['--bar-neg-color'] = props.negColor;
  return (
    <div className="cbar">
      <span className="cbar__label">{props.label}</span>
      <div className="cbar__track">
        <div className="cbar__fill" ref={props.barRef} style={style as React.CSSProperties} />
        <div className="cbar__zero" />
      </div>
    </div>
  );
}

/** −1..1 → fill grows left or right from the centre line. Sets data-neg so CSS can recolour it. */
function setBar(el: HTMLDivElement | null, n: number) {
  if (!el) return;
  const c = Math.max(-1, Math.min(1, n));
  // scaleX with origin at the centre line: negative values extend left.
  el.style.transform = `scaleX(${c.toFixed(3)})`;
  const neg = c < 0 ? '1' : '';
  if (el.dataset.neg !== neg) el.dataset.neg = neg;
}
