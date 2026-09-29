import { useState } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import type { SensorStatus } from '../../sensors/types';
import { useHzValue } from '../hooks/useHzValue';
import { ActionButton } from './ActionButton';
import { DPad } from './DPad';
import { PedalPad } from './PedalPad';
import { SteerMeter } from './SteerMeter';
import './DriveScreen.css';

/**
 * Two screens, swapped by ARM:
 *
 *   ARMED — F1                                     DISARMED — menus (a controller)
 *   ┌────────┬────────────────────┬──────────┐     ┌──────────┬──────────────────┬──────────┐
 *   │ − GEAR │ meter · ESP32 · link│  GEAR +  │     │   L1     │ meter · link     │    R1    │
 *   │────────│ DISARM · centre · …│──────────│     │    ▲     │ ARM · centre · … │    △     │
 *   │ BRAKE  │                    │ THROTTLE │     │  ◀   ▶   │                  │  □   ○   │
 *   │        │   DRS   │  BOOST   │          │     │    ▼     │    ≡ OPTIONS     │    ✕     │
 *   └────────┴────────────────────┴──────────┘     └──────────┴──────────────────┴──────────┘
 *
 * Each screen's buttons only work on that screen (ControlLoop filters them), so
 * the menu can never steer or accelerate, and ✕ in a menu can't shift gear.
 * While re-arming after a link drop, the F1 screen stays up.
 */
export function DriveScreen() {
  noteRender();
  const armed = useHzValue(runtime.live, 8, (v) => v.armed);
  const rearm = useHzValue(runtime.live, 8, (v) => v.rearmPending);
  return armed || rearm ? <F1Screen /> : <MenuScreen />;
}

function F1Screen() {
  noteRender();
  return (
    <div className="drive">
      <div className="drive__side">
        <ActionButton action="gearDown" label="− GEAR" sub="shift down" className="action--paddle" />
        <PedalPad pedal="brake" />
      </div>
      <div className="drive__center">
        <section className="panel drive__panel">
          <SteerMeter />
        </section>
        <ArmStrip />
        <div className="drive__actions">
          <ActionButton action="drs" label="DRS" className="action--drs" />
          <ActionButton action="ers" label="BOOST" sub="battery / overtake" className="action--boost" />
        </div>
      </div>
      <div className="drive__side">
        <ActionButton action="gearUp" label="GEAR +" sub="shift up" className="action--paddle" />
        <PedalPad pedal="throttle" />
      </div>
    </div>
  );
}

function MenuScreen() {
  noteRender();
  return (
    <div className="drive menu">
      <div className="menu__side">
        <div className="menu__shoulders">
          <ActionButton action="l2" label="L2" className="shoulder" />
          <ActionButton action="l1" label="L1" className="shoulder" />
        </div>
        <div className="menu__padwrap">
          <DPad />
        </div>
        <ActionButton action="l3" label="L3" sub="stick click" className="stick" />
      </div>
      <div className="drive__center">
        <section className="panel drive__panel">
          <SteerMeter />
        </section>
        <ArmStrip />
        <p className="menu__hint">Menu mode — only these buttons reach the game. ARM to drive.</p>
        <div className="menu__system">
          <ActionButton action="create" label="CREATE" sub="media" className="options" />
          <ActionButton action="ps" label="PS" className="options options--ps" />
          <ActionButton action="pause" label="≡ OPTIONS" sub="pause" className="options" />
        </div>
      </div>
      <div className="menu__side">
        <div className="menu__shoulders">
          <ActionButton action="r1" label="R1" className="shoulder" />
          <ActionButton action="r2" label="R2" className="shoulder" />
        </div>
        <div className="menu__padwrap">
          <div className="face">
            <ActionButton action="faceTriangle" label="△" className="face__btn face--triangle" />
            <ActionButton action="faceSquare" label="□" className="face__btn face--square" />
            <ActionButton action="menuBack" label="○" sub="back" className="face__btn face--circle" />
            <ActionButton action="menuSelect" label="✕" sub="select" className="face__btn face--cross" />
          </div>
        </div>
        <ActionButton action="r3" label="R3" sub="stick click" className="stick" />
      </div>
    </div>
  );
}

function ArmStrip() {
  noteRender();
  const armed = useHzValue(runtime.live, 8, (v) => v.armed);
  const ready = useHzValue(runtime.live, 8, (v) => v.outputReady);
  const sensorId = useHzValue(runtime.live, 4, (v) => v.sensorId);
  const gyro = useHzValue(runtime.live, 4, () => runtime.gyroStatus);
  const rearm = useHzValue(runtime.live, 8, (v) => v.rearmPending);
  const busy = useHzValue(runtime.live, 4, () => runtime.esp.link.state === 'busy');
  const [note, setNote] = useState('');

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? '' : n)), 3000);
  };

  const retryGyro = async () => {
    const status = await runtime.startGyro();
    flash(status === 'live' ? 'Gyro live — hold straight, tap Set centre' : (GYRO_PROBLEM[status] ?? `Gyro: ${status}`));
  };
  const onGyro = sensorId === 'deviceorientation';
  // A retry only makes sense where a gyro could exist but didn't start (denied, insecure page).
  const canRetry = !onGyro && (gyro === 'permission-denied' || gyro === 'insecure-context' || gyro === 'error');

  return (
    <div className="strip">
      <button
        type="button"
        className="strip__arm"
        data-armed={armed ? '1' : ''}
        data-rearm={rearm ? '1' : ''}
        disabled={!armed && !rearm && !ready}
        onClick={() => runtime.control.setArmed(!armed && !rearm)}
      >
        {armed ? 'DISARM' : rearm ? (ready ? 'LIFT PEDALS' : 'RECONNECTING') : ready ? 'ARM' : busy ? 'IN USE ELSEWHERE' : 'NOT CONNECTED'}
      </button>
      <button
        type="button"
        className="strip__btn"
        onClick={() => flash(runtime.control.calibrateCenter() ? 'Centre set' : 'No gyro reading to centre on')}
      >
        Set centre
      </button>
      {canRetry ? (
        <button type="button" className="strip__btn" onClick={() => void retryGyro()}>
          Retry gyro
        </button>
      ) : (
        <span className="strip__gyro" data-on={onGyro ? '1' : ''}>
          {onGyro ? 'gyro ✓' : gyro === 'starting' ? 'gyro starting…' : gyro === 'idle' ? 'touch to start gyro' : 'no gyro · sliders'}
        </span>
      )}
      <span className="strip__note">{note}</span>
    </div>
  );
}

const GYRO_PROBLEM: Partial<Record<SensorStatus, string>> = {
  'insecure-context': 'Gyro needs https — open the https:// address (pnpm dev:lan)',
  unsupported: 'No gyro on this device — staying on sliders',
  'permission-denied': 'Motion permission denied — allow it in browser settings',
};
