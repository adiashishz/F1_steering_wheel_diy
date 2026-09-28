import { useRef } from 'react';
import type { ActionId } from '@wheel/protocol';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { buttonDown, buttonUp } from '../../input/touchState';
import { useRaf } from '../hooks/useRaf';

/**
 * A momentary button: held while the finger is down. Same pointer rules as the
 * pedal pads (capture + release on up / cancel / lost capture). The game decides
 * what a press means — a shift happens once per press however long it's held.
 */
export function ActionButton(props: { action: ActionId; label: string; sub?: string; className?: string }) {
  noteRender();
  const { action } = props;
  const el = useRef<HTMLDivElement>(null);

  useRaf(runtime.live, () => {
    const on = runtime.touch.buttons[action] ? '1' : '';
    if (el.current && el.current.dataset.active !== on) el.current.dataset.active = on;
  });

  const up = (e: React.PointerEvent) => buttonUp(action, e.pointerId);

  return (
    <div
      ref={el}
      className={`action ${props.className ?? ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        buttonDown(action, e.pointerId);
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      <span className="action__label">{props.label}</span>
      {props.sub && <span className="action__sub">{props.sub}</span>}
    </div>
  );
}
