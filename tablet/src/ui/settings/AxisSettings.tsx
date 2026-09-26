import { useState } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { FIELD_PATHS, specFor, type BoolFieldSpec, type NumberFieldSpec } from '../../config/fieldSpecs';
import type { FieldPath } from '../../config/schema';
import { useConfigField } from '../hooks/useConfigField';
import './AxisSettings.css';

type Section = 'steering' | 'pitch';

const SECTIONS: { id: Section; label: string; note: string }[] = [
  { id: 'steering', label: 'Steering', note: 'Roll → steering.' },
  { id: 'pitch', label: 'Pedals', note: 'Pitch → throttle / brake. Used by the gyro-pedal modes (Phase 10).' },
];

/** Every setting under `section.`, in table order. */
const pathsFor = (section: Section) => FIELD_PATHS.filter((p) => p.startsWith(`${section}.`));

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
      <FullLockSummary section={section} />

      <div className="tune__fields">
        {pathsFor(section).map((path) => {
          const spec = specFor(path);
          return spec.kind === 'number' ? (
            <NumberField key={path} path={path} spec={spec} />
          ) : (
            <BoolField key={path} path={path} spec={spec} />
          );
        })}
      </div>
    </div>
  );
}

function NumberField(props: { path: FieldPath; spec: NumberFieldSpec }) {
  noteRender();
  const { path, spec } = props;
  const [value, set] = useConfigField(path);
  const n = value as number;
  const isDefault = n === spec.default;
  const decimals = decimalsOf(spec.step);

  return (
    <div className="field">
      <div className="field__top">
        <label className="field__label" htmlFor={path}>
          {spec.label}
        </label>
        <span className="field__value mono">
          {n.toFixed(decimals)}
          {spec.unit && <span className="field__unit">{spec.unit}</span>}
        </span>
        <button
          type="button"
          className="field__reset"
          disabled={isDefault}
          title={`Reset to ${spec.default}${spec.unit}`}
          onClick={() => runtime.config.reset(path)}
        >
          ↺
        </button>
      </div>
      <input
        id={path}
        className="field__slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={n}
        onChange={(e) => set(Number(e.currentTarget.value) as never)}
      />
      {spec.help && <p className="field__help">{spec.help}</p>}
    </div>
  );
}

function BoolField(props: { path: FieldPath; spec: BoolFieldSpec }) {
  noteRender();
  const { path, spec } = props;
  const [value, set] = useConfigField(path);
  return (
    <label className="field field--bool">
      <input type="checkbox" checked={value as boolean} onChange={(e) => set(e.currentTarget.checked as never)} />
      <span className="field__label">{spec.label}</span>
      {spec.help && <span className="field__help">{spec.help}</span>}
    </label>
  );
}

/**
 * Plain-English result of the current numbers: where full output is reached.
 * Inverts the axis math: dead zone first, then the rest of the range shrunk by sensitivity.
 *   fullAt = deadzone + (range − deadzone) / sensitivity
 * With sensitivity < 1 this is beyond `range` — you have to tilt further. That's correct.
 */
function FullLockSummary(props: { section: Section }) {
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

/** 0.05 → 2, 0.5 → 1, 1 → 0 */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}
