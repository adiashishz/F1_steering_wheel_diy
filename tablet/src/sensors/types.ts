/**
 * What every tilt sensor must look like — fake or real.
 * The control loop only talks to this interface, so the fake gyro (desktop)
 * and the real gyro (tablet) are interchangeable.
 *
 * PULL model: the sensor just remembers its newest reading. The 100 Hz loop
 * calls read() when IT is ready. So a sensor firing at an uneven 30–120 Hz
 * can't disturb the loop's timing.
 *
 * Sign convention (every source must follow it):
 *   roll  +  = right side down  → steer right
 *   pitch +  = top edge tilted away from you → throttle
 */

export type SensorId = 'simulated' | 'deviceorientation';

export type SensorStatus =
  | 'idle' //              not started
  | 'starting' //          waiting for first reading / permission
  | 'live' //              readings arriving
  | 'stale' //             was live, readings stopped
  | 'unsupported' //       no sensor on this device (e.g. desktop)
  | 'insecure-context' //  needs https or localhost
  | 'permission-denied' // iOS said no
  | 'error';

export interface SensorSample {
  /** performance.now() when this reading was taken. Lets the loop spot stale data. */
  t: number;
  /** Degrees. */
  roll: number;
  /** Degrees. */
  pitch: number;
}

export interface SensorSource {
  readonly id: SensorId;
  readonly label: string;
  /** true → start() must be called from a tap/click (iOS motion permission). */
  readonly requiresUserGesture: boolean;
  readonly status: SensorStatus;
  /** Measured readings per second. */
  readonly sampleRateHz: number;

  start(): Promise<SensorStatus>;
  stop(): void;
  /**
   * Newest reading, or null if there isn't one.
   * The returned object is REUSED — copy fields out, don't keep a reference.
   */
  read(): Readonly<SensorSample> | null;
}
