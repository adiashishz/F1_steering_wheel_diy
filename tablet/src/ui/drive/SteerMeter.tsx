import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { useRaf } from '../hooks/useRaf';

/** Friendly names for the keys the ESP32 reports. */
const KEY_NAMES: Record<string, string> = {
  Comma: '◀ steer',
  Period: 'steer ▶',
  KeyA: 'throttle',
  KeyZ: 'brake',
  Space: 'gear +',
  ShiftLeft: 'gear −',
  KeyF: 'DRS',
  KeyM: 'boost',
};

/**
 * The lock-test readout:
 *   big bar     steering being sent (gyro, or a held test chip)
 *   ESP32 line  what the board reports it's actually doing: duty, presses/s, held keys
 *   Link line   drops since load and why the last one happened
 *
 * All written straight to the DOM once per frame — renders once, then never again.
 */
export function SteerMeter() {
  noteRender();
  const fill = useRef<HTMLDivElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const source = useRef<HTMLSpanElement>(null);
  const drops = useRef<HTMLSpanElement>(null);
  const esp = useRef<HTMLSpanElement>(null);

  useRaf(runtime.live, (v) => {
    const s = v.steeringOut;
    if (fill.current) {
      fill.current.style.transform = `scaleX(${Math.max(-1, Math.min(1, s)).toFixed(3)})`;
      const neg = s < 0 ? '1' : '';
      if (fill.current.dataset.neg !== neg) fill.current.dataset.neg = neg;
    }
    setText(value.current, steerText(s));
    setText(source.current, v.sensorFresh ? v.sensorId : 'no gyro reading');
    const l = runtime.esp.link;
    setText(drops.current, l.drops === 0 ? 'no drops' : `${l.drops} drop${l.drops > 1 ? 's' : ''} · last ${l.lastDrop}`);
    setText(esp.current, espText());
  });

  return (
    <div className="meter">
      <div className="meter__top">
        <span ref={value} className="meter__value mono">
          —
        </span>
        <span ref={source} className="meter__source" />
      </div>
      <div className="meter__track">
        <div ref={fill} className="meter__fill" />
        <div className="meter__zero" />
      </div>
      <div className="meter__lines">
        <div>
          <span className="meter__label">ESP32</span>
          <span ref={esp} className="mono" />
        </div>
        <div>
          <span className="meter__label">Link</span>
          <span ref={drops} className="mono" />
        </div>
      </div>
    </div>
  );
}

function setText(el: HTMLElement | null, text: string) {
  if (el && el.textContent !== text) el.textContent = text;
}

function steerText(s: number): string {
  const pct = Math.round(Math.abs(s) * 100);
  if (pct === 0) return 'centre';
  return s < 0 ? `◀ ${pct}%` : `${pct}% ▶`;
}

function espText(): string {
  const link = runtime.esp.link;
  const st = link.status;
  if (link.state !== 'live' || !st) return link.state === 'live' ? 'waiting for status…' : `not connected (${link.state})`;
  if (st.watchdogTripped) return 'WATCHDOG TRIPPED — all keys released';
  if (!st.outputArmed) return 'disarmed — nothing pressed';
  const held = Object.keys(st.keys)
    .filter((k) => st.keys[k])
    .map((k) => KEY_NAMES[k] ?? k);
  const duty = st.steerDuty === undefined ? '—' : `${Math.round(st.steerDuty * 100)}%`;
  const presses = st.steerPressesPerSec === undefined ? '—' : String(Math.round(st.steerPressesPerSec));
  return `duty ${duty} · ${presses} presses/s · ${held.length ? held.join(' + ') : 'no keys'}`;
}
