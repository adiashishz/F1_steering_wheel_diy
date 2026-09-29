import { useRef } from 'react';
import { runtime } from '../../core/runtime';
import { noteRender } from '../../core/telemetry';
import { buttonDown, buttonUp } from '../../input/touchState';
import { useHzValue } from '../hooks/useHzValue';

/** A pointer id no finger will ever have, so the test press can't clash with a real touch. */
const TEST_POINTER = -4242;
const FLASH_MS = 150;

/**
 * End-to-end latency, measured with a camera:
 *
 *   tap → the WHOLE screen flashes white  +  D-pad right is pressed, same instant
 *   film tablet + TV in slow motion (240 fps ≈ 4 ms/frame)
 *   count frames: flash → menu highlight moves on the TV   = finger-to-picture latency
 *
 * Only works DISARMED (menu mode — D-pad is a menu button), so it can't touch driving.
 * The press leaves at once (touch changes kick an immediate send); the flash
 * shows on the next screen frame, so it trails the press by up to one frame and
 * the measured latency reads that much LOW.
 */
export function LatencyTest() {
  noteRender();
  const menu = useHzValue(runtime.live, 4, (v) => v.menuMode);
  const flash = useRef<HTMLDivElement | null>(null);

  const fire = () => {
    let el = flash.current;
    if (!el) {
      el = document.createElement('div');
      el.className = 'latency-flash';
      document.body.appendChild(el);
      flash.current = el;
    }
    el.style.display = 'block';
    buttonDown('dpadRight', TEST_POINTER);
    setTimeout(() => {
      el!.style.display = 'none';
      buttonUp('dpadRight', TEST_POINTER);
    }, FLASH_MS);
  };

  return (
    <div className="probe">
      <h3 className="telemetry__title">Latency test (camera)</h3>
      <p className="probe__note">
        Open a game menu on the TV. Film the tablet and TV together in <b>slow motion</b>, tap below, then count
        frames from the white flash to the highlight moving. Sends <b>D-pad right</b>.
      </p>
      <button type="button" className="latency__btn" disabled={!menu} onClick={fire}>
        {menu ? 'Flash + D-pad right' : 'DISARM first (menu mode)'}
      </button>
    </div>
  );
}
