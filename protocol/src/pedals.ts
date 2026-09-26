/**
 * Throttle/brake exclusivity (plan.md §10, §19.5).
 *
 * Gyro pedals can't press both: one tilt axis is either forward or back.
 * Touch pedals CAN — two fingers. This guard settles it.
 *
 * Runs in TWO places on purpose:
 *   tablet → in every control mode, before sending
 *   ESP32  → again on receive, so a buggy tablet still can't hold W and S together
 */

import type { ControllerState } from './controllerState';

export type ExclusivityPolicy = 'dominant' | 'brake-wins' | 'cancel-both' | 'allow-both';

export const EXCLUSIVITY_POLICIES: readonly ExclusivityPolicy[] = [
  'dominant',
  'brake-wins',
  'cancel-both',
  'allow-both',
];

/** Below this a pedal counts as "not pressed", so a resting finger doesn't cancel the other pedal. */
export const DEFAULT_EXCLUSIVITY_THRESHOLD = 0.05;

/**
 * Changes `s` in place. Returns true if it had to zero something (handy for the debug panel).
 *
 *   both pedals above threshold?
 *     'dominant'    → zero the smaller one; a tie goes to brake       (default)
 *     'brake-wins'  → zero throttle
 *     'cancel-both' → zero both
 *     'allow-both'  → leave them — only if turned on deliberately in settings
 */
export function enforceExclusivity(
  s: Pick<ControllerState, 'throttle' | 'brake'>,
  policy: ExclusivityPolicy,
  threshold: number = DEFAULT_EXCLUSIVITY_THRESHOLD,
): boolean {
  if (policy === 'allow-both') return false;
  if (s.throttle <= threshold || s.brake <= threshold) return false;

  switch (policy) {
    case 'dominant':
      // Tie goes to brake: when unsure, slowing down is the safe choice.
      if (s.throttle > s.brake) s.brake = 0;
      else s.throttle = 0;
      return true;
    case 'brake-wins':
      s.throttle = 0;
      return true;
    case 'cancel-both':
      s.throttle = 0;
      s.brake = 0;
      return true;
  }
}
