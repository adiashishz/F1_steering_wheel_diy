/**
 * The real gyro: the browser's `deviceorientation` event (fused gyro + accelerometer).
 *
 *   start()  → secure context?  → iOS permission (needs a tap)  → listen
 *   event    → orientationToRollPitch() → remember newest sample
 *   read()   → newest sample (the 100 Hz loop pulls it; events arrive at their own rate)
 *
 * Relative `deviceorientation`, not `deviceorientationabsolute`: we calibrate our
 * own centre, so the magnetometer would only add drift.
 *
 * Desktop Chrome fires one event with null angles, or none at all. Both count
 * as 'unsupported' so the UI can fall back to the simulated gyro.
 */

import { RateMeter } from '../core/telemetry';
import { orientationToRollPitch, screenAngle } from './orientationMath';
import type { SensorSample, SensorSource, SensorStatus } from './types';

/** No real reading this long after start() → treat the device as having no gyro. */
const FIRST_READING_TIMEOUT_MS = 1500;
/** Live, then nothing for this long → 'stale'. */
const STALE_MS = 500;

type PermissionFn = () => Promise<'granted' | 'denied'>;

export class DeviceOrientationSource implements SensorSource {
  readonly id = 'deviceorientation' as const;
  readonly label = 'Tablet gyro';
  /** iOS 13+ only allows the permission prompt from a tap. */
  readonly requiresUserGesture = typeof permissionFn() === 'function';

  private _status: SensorStatus = 'idle';
  private readonly rate = new RateMeter();
  private readonly sample: SensorSample = { t: 0, roll: 0, pitch: 0 };
  private hasSample = false;
  private angle = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  get status(): SensorStatus {
    if (this._status === 'live' && performance.now() - this.sample.t > STALE_MS) return 'stale';
    return this._status;
  }

  get sampleRateHz(): number {
    return this.rate.read(performance.now());
  }

  /** Whether this browser could ever give readings (for showing the "use gyro" button). */
  static isAvailable(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  async start(): Promise<SensorStatus> {
    if (this._status === 'live' || this._status === 'starting') return this._status;
    if (!window.isSecureContext) return (this._status = 'insecure-context');
    if (!DeviceOrientationSource.isAvailable()) return (this._status = 'unsupported');

    const ask = permissionFn();
    if (ask) {
      try {
        if ((await ask()) !== 'granted') return (this._status = 'permission-denied');
      } catch {
        // Thrown when not called from a tap.
        return (this._status = 'permission-denied');
      }
    }

    this._status = 'starting';
    this.hasSample = false;
    this.angle = screenAngle();
    window.addEventListener('deviceorientation', this.onEvent);
    screen.orientation?.addEventListener('change', this.onRotate);
    window.addEventListener('orientationchange', this.onRotate);

    this.timeout = setTimeout(() => {
      if (!this.hasSample) {
        this.stop();
        this._status = 'unsupported';
      }
    }, FIRST_READING_TIMEOUT_MS);
    return this._status;
  }

  stop(): void {
    window.removeEventListener('deviceorientation', this.onEvent);
    screen.orientation?.removeEventListener('change', this.onRotate);
    window.removeEventListener('orientationchange', this.onRotate);
    clearTimeout(this.timeout);
    this.rate.reset();
    this.hasSample = false;
    this._status = 'idle';
  }

  read(): Readonly<SensorSample> | null {
    return this.hasSample ? this.sample : null;
  }

  private readonly onEvent = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return; // desktop: event without data
    const now = performance.now();
    orientationToRollPitch(e.beta, e.gamma, this.angle, this.sample);
    this.sample.t = now;
    this.hasSample = true;
    this.rate.mark(now);
    if (this._status === 'starting') {
      this._status = 'live';
      clearTimeout(this.timeout);
    }
  };

  private readonly onRotate = (): void => {
    this.angle = screenAngle();
  };
}

function permissionFn(): PermissionFn | undefined {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return undefined;
  const fn = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn }).requestPermission;
  return typeof fn === 'function' ? fn.bind(DeviceOrientationEvent) : undefined;
}
