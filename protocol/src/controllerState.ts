/**
 * ControllerState — the one object the whole system passes around.
 *
 *   tablet UI ──fills──► ControllerState ──sent to──► ESP32 ──turns into──► keys
 *
 * It describes WHAT the driver is doing, never HOW it gets output.
 * No key codes here on purpose: if the PS5 keyboard route fails (plan.md §1),
 * only the output side changes.
 */

/** Name of a digital action, e.g. 'gearUp', 'drs'. Defined by config, not hard-coded. */
export type ActionId = string;

export interface ControllerState {
  /** -1 = full left, 0 = centre, +1 = full right. */
  steering: number;
  /** 0 = off, 1 = full throttle. */
  throttle: number;
  /** 0 = off, 1 = full brake. */
  brake: number;
  /** Every bound action, true while held. */
  buttons: Record<ActionId, boolean>;
}

/**
 * How close to zero an axis must be to count as "released".
 * Smoothing makes a released pedal approach 0 without ever hitting exactly 0,
 * so an exact `=== 0` check would never pass.
 */
export const NEUTRAL_EPSILON = 0.01;

/** Fresh all-released state. Use this to create the one state object a loop owns. */
export function createNeutralState(): ControllerState {
  return { steering: 0, throttle: 0, brake: 0, buttons: {} };
}

/** Read-only reference neutral state. Compare against it; never mutate it. */
export const NEUTRAL_STATE: Readonly<ControllerState> = Object.freeze({
  steering: 0,
  throttle: 0,
  brake: 0,
  buttons: Object.freeze({}) as Record<ActionId, boolean>,
});

/** True when nothing is being steered, pressed or held. */
export function isNeutral(s: Readonly<ControllerState>, epsilon = NEUTRAL_EPSILON): boolean {
  if (Math.abs(s.steering) > epsilon) return false;
  if (s.throttle > epsilon) return false;
  if (s.brake > epsilon) return false;
  for (const id in s.buttons) {
    if (s.buttons[id]) return false;
  }
  return true;
}

/**
 * Zero a state IN PLACE. Buttons are set to false rather than deleted, so the
 * object keeps its shape and the 100 Hz loop never allocates a new one.
 */
export function resetToNeutral(s: ControllerState): void {
  s.steering = 0;
  s.throttle = 0;
  s.brake = 0;
  for (const id in s.buttons) {
    s.buttons[id] = false;
  }
}
