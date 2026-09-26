/**
 * Fake gyro for desktop testing. The sliders / drag pad (piece 2.5) call
 * setRoll / setPitch; the loop reads it exactly like the real gyro.
 *
 * Adds optional jitter because real gyros wobble — without it, smoothing and
 * the dead zone would have nothing to do and you couldn't tune them.
 */

import type { SensorSample, SensorSource, SensorStatus } from './types';
import { RateMeter } from '../core/telemetry';

export interface SimulatedSensorOptions {
  /** Wobble added to every reading, as a standard deviation in degrees. 0 = perfectly still. */
  jitterDeg?: number;
  clock?: () => number;
}

/** A tablet held like a wheel won't go past this. */
const LIMIT_DEG = 90;

export class SimulatedSensorSource implements SensorSource {
  readonly id = 'simulated' as const;
  readonly label = 'Simulated (sliders)';
  readonly requiresUserGesture = false;

  private _status: SensorStatus = 'idle';
  private targetRoll = 0;
  private targetPitch = 0;
  private jitterDeg: number;
  private readonly clock: () => number;
  private readonly rate = new RateMeter();
  /** Reused every read — see SensorSource.read(). */
  private readonly sample: SensorSample = { t: 0, roll: 0, pitch: 0 };

  constructor(opts: SimulatedSensorOptions = {}) {
    this.jitterDeg = Math.max(0, opts.jitterDeg ?? 0.3);
    this.clock = opts.clock ?? (() => performance.now());
  }

  get status(): SensorStatus {
    return this._status;
  }

  get sampleRateHz(): number {
    return this.rate.read(this.clock());
  }

  get roll(): number {
    return this.targetRoll;
  }

  get pitch(): number {
    return this.targetPitch;
  }

  async start(): Promise<SensorStatus> {
    this._status = 'live';
    return this._status;
  }

  stop(): void {
    this._status = 'idle';
    this.rate.reset();
  }

  setRoll(deg: number): void {
    if (Number.isFinite(deg)) this.targetRoll = clampDeg(deg);
  }

  setPitch(deg: number): void {
    if (Number.isFinite(deg)) this.targetPitch = clampDeg(deg);
  }

  setJitter(deg: number): void {
    if (Number.isFinite(deg)) this.jitterDeg = Math.max(0, deg);
  }

  read(): Readonly<SensorSample> | null {
    if (this._status !== 'live') return null;
    const now = this.clock();
    this.rate.mark(now);
    this.sample.t = now;
    this.sample.roll = this.targetRoll + noise(this.jitterDeg);
    this.sample.pitch = this.targetPitch + noise(this.jitterDeg);
    return this.sample;
  }
}

function clampDeg(d: number): number {
  return Math.min(Math.max(d, -LIMIT_DEG), LIMIT_DEG);
}

/**
 * Bell-curve-ish noise with the given standard deviation.
 * Sum of 4 uniform randoms has std √(4/12) ≈ 0.577, so scale by std / 0.577.
 */
function noise(std: number): number {
  if (std === 0) return 0;
  const u = Math.random() + Math.random() + Math.random() + Math.random() - 2;
  return (u / 0.57735) * std;
}
