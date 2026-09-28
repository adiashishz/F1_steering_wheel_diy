import { useState } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { FIELD_PATHS } from '../../config/fieldSpecs';
import { useConfigField } from '../hooks/useConfigField';
import { SettingField } from './SettingField';
import './AxisSettings.css';

type Section = 'steering' | 'pitch' | 'steerOutput';

const SECTIONS: { id: Section; label: string; note: string }[] = [
  { id: 'steering', label: 'Steering', note: 'Roll → steering.' },
  { id: 'pitch', label: 'Pedals', note: 'Pitch → throttle / brake. Used by the gyro-pedal modes (Phase 10).' },
  {
    id: 'steerOutput',
    label: 'Steer pulses',
    note: 'The ESP32 pulses the steer key (PWM). On-time = steering ÷ "solid hold from" × max duty.',
  },
];

/** Every setting under `section.`, in table order. */
// Steering is always PWM now, so the mode picker is hidden.
const pathsFor = (section: Section) =>
  FIELD_PATHS.filter((p) => p.startsWith(`${section}.`) && p !== 'steerOutput.mode');

/**
 * Tuning sliders, generated from fieldSpecs.ts — one control per row in the table.
 * Changes apply to the running loop immediately.
 */
export function AxisSettings() {
  noteRender();
  const [section, setSection] = useState<Section>('steering');
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="tune">
      <div className="tune__head">
        <div className="tune__tabs" role="tablist">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === section}
              className="tune__tab"
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tune__reset-all"
          onClick={() => {
            for (const p of pathsFor(section)) runtime.config.reset(p);
          }}
        >
          Reset {current.label.toLowerCase()}
        </button>
      </div>

      <p className="tune__note">{current.note}</p>
      {section !== 'steerOutput' && <FullLockSummary section={section} />}

      <div className="tune__fields">
        {pathsFor(section).map((path) => (
          <SettingField key={path} path={path} />
        ))}
      </div>
    </div>
  );
}

/**
 * Plain-English result of the current numbers: where full output is reached.
 * Inverts the axis math: dead zone first, then the rest of the range shrunk by sensitivity.
 *   fullAt = deadzone + (range − deadzone) / sensitivity
 * With sensitivity < 1 this is beyond `range` — you have to tilt further. That's correct.
 */
function FullLockSummary(props: { section: 'steering' | 'pitch' }) {
  const s = props.section;
  const [range] = useConfigField(`${s}.rangeDeg`);
  const [dz] = useConfigField(`${s}.deadzoneDeg`);
  const [sens] = useConfigField(`${s}.sensitivity`);
  const fullAt = dz + (range - dz) / sens;
  return (
    <p className="tune__summary">
      {s === 'steering' ? (
        <>
          Nothing within <b>±{dz}°</b>, full lock at <b>±{fullAt.toFixed(1)}°</b> of tilt.
        </>
      ) : (
        <>
          Neither pedal within <b>±{dz}°</b>, full throttle / brake at <b>±{fullAt.toFixed(1)}°</b>.
        </>
      )}
    </p>
  );
}
