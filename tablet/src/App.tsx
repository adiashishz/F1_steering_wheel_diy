import { useRef, useState } from 'react';
import { PROTOCOL_VERSION } from '@wheel/protocol';
import { runtime } from './core/runtime';
import { noteRender } from './core/telemetry';
import { useHzValue } from './ui/hooks/useHzValue';
import { useRaf } from './ui/hooks/useRaf';
import { SimSensorPanel } from './ui/sim/SimSensorPanel';
import { TelemetryPanel } from './ui/debug/TelemetryPanel';
import { AxisSettings } from './ui/settings/AxisSettings';
import { AxisScope } from './ui/debug/AxisScope';
import { DriveScreen } from './ui/drive/DriveScreen';
import { TouchProbe } from './ui/debug/TouchProbe';
import { FullscreenButton } from './ui/FullscreenButton';
import './App.css';

type Tab = 'drive' | 'tune';

/**
 *   ┌ header: title + status pills ─────────────────────────────┐
 *   │ Drive: pedals · steering meter · lock-test controls       │
 *   │ Tune:  fake gyro + graph │ tuning sliders │ telemetry      │
 *   └ footer: Drive / Tune tabs · ESP32 address ────────────────┘
 */
export function App() {
  noteRender();
  const [tab, setTab] = useState<Tab>('drive');
  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__title">F1 TABLET WHEEL</span>
        <div className="shell__pills">
          <SensorPill />
          <LoopPill />
          <OutputPill />
          <EspPill />
          <Pill label="Proto" value={`v${PROTOCOL_VERSION}`} tone="dim" />
        </div>
      </header>

      {tab === 'drive' ? (
        <main className="shell__body shell__body--drive">
          <DriveScreen />
        </main>
      ) : (
      <main className="shell__body">
        <div className="shell__drive">
          <div className="shell__col">
            <section className="panel">
              <SimSensorPanel />
            </section>
            <section className="panel">
              <AxisScope />
            </section>
          </div>
          <section className="panel">
            <AxisSettings />
          </section>
        </div>
        <aside className="panel shell__debug">
          <TouchProbe />
          <TelemetryPanel />
        </aside>
      </main>
      )}

      <footer className="shell__footer">
        <div className="tune__tabs" role="tablist">
          {(['drive', 'tune'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className="tune__tab"
              onClick={() => setTab(t)}
            >
              {t === 'drive' ? 'Drive' : 'Tune'}
            </button>
          ))}
        </div>
        <FullscreenButton />
        <span className="placeholder mono">{runtime.esp.link.url}</span>
      </footer>

      <div className="rotate-hint">Rotate to landscape</div>
    </div>
  );
}

type Tone = 'dim' | 'go' | 'warn' | 'bad';

function Pill(props: { label: string; value: string; tone: Tone }) {
  return (
    <span className={`pill pill--${props.tone}`}>
      <span className="pill__label">{props.label}</span>
      <span className="pill__value mono">{props.value}</span>
    </span>
  );
}

/** Re-renders only when the sensor status string changes. */
function SensorPill() {
  noteRender();
  const status = useHzValue(runtime.live, 2, (v) => v.sensorStatus);
  const id = useHzValue(runtime.live, 2, (v) => v.sensorId);
  return <Pill label="Sensor" value={id ? `${id} · ${status}` : status} tone={status === 'live' ? 'go' : 'warn'} />;
}

/** Which output is plugged in, and whether it's armed. Re-renders only on change. */
function OutputPill() {
  noteRender();
  const id = useHzValue(runtime.live, 4, (v) => v.outputId);
  const armed = useHzValue(runtime.live, 4, (v) => v.armed);
  const ready = useHzValue(runtime.live, 4, (v) => v.outputReady);
  const tone: Tone = !ready ? 'dim' : armed ? 'bad' : 'go';
  return <Pill label="Output" value={`${id || 'none'} · ${armed ? 'ARMED' : 'safe'}`} tone={tone} />;
}

/** ESP32 link state (re-renders on change) + round trip (written straight to the DOM). */
function EspPill() {
  noteRender();
  const state = useHzValue(runtime.live, 4, () => runtime.esp.link.state);
  const rtt = useRef<HTMLSpanElement>(null);
  useRaf(runtime.live, () => {
    const ms = runtime.esp.link.rttMs;
    const text = state === 'live' ? (Number.isFinite(ms) ? ` · ${ms.toFixed(0)} ms` : '') : '';
    if (rtt.current && rtt.current.textContent !== text) rtt.current.textContent = text;
  });
  const tone: Tone = state === 'live' ? 'go' : state === 'rejected' ? 'bad' : 'warn';
  return (
    <span className={`pill pill--${tone}`} title={runtime.esp.link.lastError}>
      <span className="pill__label">ESP32</span>
      <span className="pill__value mono">
        {state}
        <span ref={rtt} />
      </span>
    </span>
  );
}

/** Updates every frame without re-rendering. */
function LoopPill() {
  noteRender();
  const pill = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  useRaf(runtime.live, (v) => {
    const hz = Math.round(v.loopHz);
    const text = `${hz} Hz`;
    if (value.current && value.current.textContent !== text) value.current.textContent = text;
    const cls = `pill pill--${hz >= 95 ? 'go' : hz >= 60 ? 'warn' : 'bad'}`;
    if (pill.current && pill.current.className !== cls) pill.current.className = cls;
  });
  return (
    <span ref={pill} className="pill pill--dim">
      <span className="pill__label">Loop</span>
      <span ref={value} className="pill__value mono">
        —
      </span>
    </span>
  );
}
