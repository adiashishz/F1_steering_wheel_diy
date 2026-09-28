/**
 * Drops everything. Never "ready", so nothing can be armed against it.
 * The safe thing to plug in when no real output is chosen.
 */

import type { ControllerState } from '@wheel/protocol';
import { createOutputStats, type OutputDevice } from './OutputDevice';

export class NullOutput implements OutputDevice {
  readonly id = 'null';
  readonly label = 'None';
  readonly ready = false;
  readonly stats = createOutputStats();

  send(_state: Readonly<ControllerState>, _now: number, _armed: boolean): void {
    this.stats.dropped++;
  }

  releaseAll(_now: number, _reason: string): void {
    this.stats.releases++;
  }

  configure(): void {}

  dispose(): void {}
}
