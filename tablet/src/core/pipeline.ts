/**
 * One tick's worth of raw inputs, gathered in one place.
 *
 *   sensor.read() ─┐
 *   (touch, 5.1) ──┼─► RawInputFrame ─► mapper (Phase 3/10) ─► ControllerState
 *
 * Flat fields on purpose — simple to reason about, and ports to C++ as a plain struct.
 * The loop owns ONE frame and refills it every tick (no allocation).
 */

import type { SensorSource } from '../sensors/types';

export interface RawInputFrame {
  /** performance.now() of this tick. */
  t: number;
  /** ms since the previous tick. */
  dt: number;
  /** true → the loop just skipped ahead after falling far behind. Reset smoothing. */
  stalled: boolean;

  /** Did the sensor give us any reading at all? */
  hasSensor: boolean;
  /** Reading is recent enough to trust (age ≤ staleSensorMs). */
  sensorFresh: boolean;
  /** How old the reading is. Infinity when there is none. */
  sensorAgeMs: number;
  /** Degrees. Last good value is kept when there's no reading. */
  roll: number;
  pitch: number;
}

/** A gyro reading older than this is not trusted for control. */
export const DEFAULT_STALE_SENSOR_MS = 120;

export function createFrame(): RawInputFrame {
  return {
    t: 0,
    dt: 0,
    stalled: false,
    hasSensor: false,
    sensorFresh: false,
    sensorAgeMs: Infinity,
    roll: 0,
    pitch: 0,
  };
}

/** Refill `frame` in place from this tick's inputs. */
export function buildFrame(
  frame: RawInputFrame,
  sensor: SensorSource,
  now: number,
  dt: number,
  stalled: boolean,
  staleSensorMs: number = DEFAULT_STALE_SENSOR_MS,
): RawInputFrame {
  frame.t = now;
  frame.dt = dt;
  frame.stalled = stalled;

  const s = sensor.read();
  if (s) {
    frame.hasSensor = true;
    // Clamp: a source can stamp its reading a hair after `now` was taken.
    frame.sensorAgeMs = Math.max(0, now - s.t);
    frame.sensorFresh = frame.sensorAgeMs <= staleSensorMs;
    // Copy the numbers out: read() reuses its object.
    frame.roll = s.roll;
    frame.pitch = s.pitch;
  } else {
    frame.hasSensor = false;
    frame.sensorFresh = false;
    frame.sensorAgeMs = Infinity;
  }
  return frame;
}
