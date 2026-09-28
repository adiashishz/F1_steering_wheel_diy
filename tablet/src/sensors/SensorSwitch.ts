/**
 * One SensorSource that forwards to whichever real source is chosen.
 * The control loop holds this and never needs to know a switch happened —
 * it just sees `id` change and resets its smoothing.
 *
 *   sensors.use('deviceorientation')   → start the gyro; on failure stay on the old one
 *   sensors.use('simulated')           → back to the desktop sliders
 */

import type { SensorId, SensorSample, SensorSource, SensorStatus } from './types';

export class SensorSwitch implements SensorSource {
  private readonly sources: Record<SensorId, SensorSource>;
  private active: SensorSource;

  constructor(sources: Record<SensorId, SensorSource>, initial: SensorId) {
    this.sources = sources;
    this.active = sources[initial];
  }

  get id(): SensorId {
    return this.active.id;
  }
  get label(): string {
    return this.active.label;
  }
  get requiresUserGesture(): boolean {
    return this.active.requiresUserGesture;
  }
  get status(): SensorStatus {
    return this.active.status;
  }
  get sampleRateHz(): number {
    return this.active.sampleRateHz;
  }

  start(): Promise<SensorStatus> {
    return this.active.start();
  }

  stop(): void {
    this.active.stop();
  }

  read(): Readonly<SensorSample> | null {
    return this.active.read();
  }

  /**
   * Switch source. Call from a tap when the target needs a user gesture (iOS).
   * Resolves to the new source's status; if it didn't come up, the old source stays active.
   */
  async use(id: SensorId): Promise<SensorStatus> {
    const next = this.sources[id];
    if (next === this.active) return this.active.start();
    let status = await next.start();
    // Wait for the first reading (or the source giving up) before switching over.
    for (let waited = 0; status === 'starting' && waited < 2000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
      status = next.status;
    }
    if (status !== 'live') {
      next.stop();
      return status;
    }
    this.active.stop();
    this.active = next;
    return status;
  }
}
