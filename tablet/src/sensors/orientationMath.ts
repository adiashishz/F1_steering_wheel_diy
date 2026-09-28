/**
 * deviceorientation angles → roll / pitch for a tablet held like a wheel.
 *
 * Don't read `gamma` as roll: Euler angles flip near beta = ±90°, which is
 * exactly where an upright tablet lives. Instead, find which way is UP in
 * screen coordinates and measure angles from that:
 *
 *   (beta, gamma) ──► up vector in device axes ──rotate by screen angle──► up in screen axes
 *                                                                           │
 *     roll  = atan2(−up.x, up.y)          how far the screen is turned, like a wheel
 *     pitch = atan2(up.z, |up.xy|)        how far the top edge leans away from you
 *
 * Device axes (W3C): x → right edge, y → top edge, z → out of the screen, in
 * the device's natural orientation. alpha (compass heading) doesn't change
 * which way is up, so it's ignored.
 *
 * Signs match sensors/types.ts: roll + = right side down, pitch + = top away.
 * Pure math, no DOM — safe to unit test later.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface RollPitch {
  roll: number;
  pitch: number;
}

/**
 * @param betaDeg   front-back tilt from the event
 * @param gammaDeg  left-right tilt from the event
 * @param screenAngleDeg  screen.orientation.angle: 0, 90, 180 or 270
 *                        (90 = device turned so its top edge points LEFT)
 * @param out  filled in place and returned (no allocation on the hot path)
 */
export function orientationToRollPitch(
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg: number,
  out: RollPitch,
): RollPitch {
  const b = betaDeg * RAD;
  const g = gammaDeg * RAD;

  // Third row of the ZXY rotation matrix = earth's up, seen in device axes.
  const dx = -Math.cos(b) * Math.sin(g);
  const dy = Math.sin(b);
  const dz = Math.cos(b) * Math.cos(g);

  // Device axes → screen axes (what the user sees as right / up).
  const a = screenAngleDeg * RAD;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const sx = dx * ca - dy * sa;
  const sy = dx * sa + dy * ca;

  out.roll = Math.atan2(-sx, sy) * DEG;
  out.pitch = Math.atan2(dz, Math.hypot(sx, sy)) * DEG;
  return out;
}

/** Current screen rotation in degrees. iOS < 16.4 only has the old window.orientation. */
export function screenAngle(): number {
  const a = screen.orientation?.angle;
  if (typeof a === 'number') return a;
  const legacy = (window as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}
