import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { specFor, type BoolFieldSpec, type EnumFieldSpec, type NumberFieldSpec } from '../../config/fieldSpecs';
import type { FieldPath } from '../../config/schema';
import { useConfigField } from '../hooks/useConfigField';
import './AxisSettings.css';

/**
 * One settings control, picked from the fieldSpecs row:
 *   number → slider · bool → checkbox · enum → segmented buttons
 * Each re-renders only when its own setting changes.
 */
export function SettingField(props: { path: FieldPath }) {
  const spec = specFor(props.path);
  if (spec.kind === 'number') return <NumberField path={props.path} spec={spec} />;
  if (spec.kind === 'enum') return <EnumField path={props.path} spec={spec} />;
  return <BoolField path={props.path} spec={spec} />;
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

function EnumField(props: { path: FieldPath; spec: EnumFieldSpec }) {
  noteRender();
  const { path, spec } = props;
  const [value, set] = useConfigField(path);
  return (
    <div className="field">
      <div className="field__top">
        <span className="field__label">{spec.label}</span>
      </div>
      <div className="tune__tabs field__enum" role="radiogroup" aria-label={spec.label}>
        {spec.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-selected={value === o.value}
            className="tune__tab"
            onClick={() => set(o.value as never)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {spec.help && <p className="field__help">{spec.help}</p>}
    </div>
  );
}

/** 0.05 → 2, 0.5 → 1, 1 → 0 */
function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}
