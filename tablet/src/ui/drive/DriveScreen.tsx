import { useState } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import type { SensorStatus } from '../../sensors/types';
import { useHzValue } from '../hooks/useHzValue';
import { ActionButton } from './ActionButton';
import { PedalPad } from './PedalPad';
import { SteerMeter } from './SteerMeter';
import './DriveScreen.css';

/**
 *   ┌────────┬──────────────────────────────────┬──────────┐
 *   │ − GEAR │ steering meter · ESP32 · drops   │  GEAR +  │
 *   │────────│ ARM · Set centre · Use gyro      │──────────│
 *   │ BRAKE  │                                  │ THROTTLE │
 *   │        │      DRS        │     BOOST      │          │
 *   └────────┴──────────────────────────────────┴──────────┘
 * Steering is always PWM pulses; the pulse numbers live in the Tune tab.
 */
export function DriveScreen() {
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

function ArmStrip() {
  noteRender();
  const armed = useHzValue(runtime.live, 8, (v) => v.armed);
  const ready = useHzValue(runtime.live, 8, (v) => v.outputReady);
  const sensorId = useHzValue(runtime.live, 4, (v) => v.sensorId);
  const rearm = useHzValue(runtime.live, 8, (v) => v.rearmPending);
  const [note, setNote] = useState('');

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? '' : n)), 3000);
  };

  const onGyro = async () => {
    const target = sensorId === 'deviceorientation' ? 'simulated' : 'deviceorientation';
    const status = await runtime.sensor.use(target);
    if (status === 'live') flash(target === 'simulated' ? 'Using simulated gyro' : 'Tablet gyro live — hold straight, tap Set centre');
    else flash(GYRO_PROBLEM[status] ?? `Gyro: ${status}`);
  };

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
        {armed ? 'DISARM' : rearm ? (ready ? 'LIFT PEDALS' : 'RECONNECTING') : ready ? 'ARM' : 'NO ESP32'}
      </button>
      <button
        type="button"
        className="strip__btn"
        onClick={() => flash(runtime.control.calibrateCenter() ? 'Centre set' : 'No gyro reading to centre on')}
      >
        Set centre
      </button>
      <button type="button" className="strip__btn" onClick={() => void onGyro()}>
        {sensorId === 'deviceorientation' ? 'Use sliders' : 'Use tablet gyro'}
      </button>
      <span className="strip__note">{note}</span>
    </div>
  );
}

const GYRO_PROBLEM: Partial<Record<SensorStatus, string>> = {
  'insecure-context': 'Gyro needs https — open the https:// address (pnpm dev:lan)',
  unsupported: 'No gyro on this device — staying on sliders',
  'permission-denied': 'Motion permission denied — allow it in browser settings',
};
