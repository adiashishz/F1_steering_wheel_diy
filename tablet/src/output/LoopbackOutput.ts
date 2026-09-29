/**
 * LoopbackOutput — the ESP32's key logic, running inside the browser.
 *
 * No server, no board: you see exactly which keys the ESP32 WOULD press.
 * It follows the same steps, in the same order, as the firmware must
 * (protocol/controller-state.md §4):
 *
 *   send(state, armed)
 *     not armed?          → release everything (at once, first time) and stay neutral
 *     copy the state      → re-apply throttle/brake exclusivity (never trust the sender)
 *     KeyStateMachine     → key down / key up events (shared code from @wheel/protocol)
 *
 * The UI reads `keys` (what's held now) and `log` (recent events).
 */

import {
  DEFAULT_EXCLUSIVITY_THRESHOLD,
  DEFAULT_KEYMAP,
  KeyStateMachine,
  NEUTRAL_STATE,
  createNeutralState,
  enforceExclusivity,
  type ControllerState,
  type KeyCode,
  type KeyEvent,
  type KeyMapConfig,
} from '@wheel/protocol';
import { createOutputStats, type OutputDevice, type OutputOptions } from './OutputDevice';

/** How many recent key events to keep for the UI. */
const LOG_SIZE = 40;

export class LoopbackOutput implements OutputDevice {
  readonly id = 'loopback';
  readonly label = 'Loopback (in browser)';
  readonly ready = true;
  readonly stats = createOutputStats();

  private readonly machine: KeyStateMachine;
  /** Our own copy, so exclusivity can be applied without touching the loop's state. */
  private readonly scratch: ControllerState = createNeutralState();
  private wasArmed = false;

  /** Every bound key → held right now? Updated in place. */
  readonly keys: Record<KeyCode, boolean> = {};
  /** Recent events, oldest first. Fixed-size ring; read with `recentEvents()`. */
  private readonly log: KeyEvent[] = [];
  private logHead = 0;
  /** Bumps on every key event — lets the UI skip redrawing when nothing changed. */
  version = 0;

  constructor(keymap: KeyMapConfig = DEFAULT_KEYMAP) {
    this.machine = new KeyStateMachine(keymap);
    this.machine.snapshot(this.keys);
    for (let i = 0; i < LOG_SIZE; i++) this.log.push({ key: '', down: false, t: -1 });
  }

  get keymap(): Readonly<KeyMapConfig> {
    return this.machine.config;
  }

  send(state: Readonly<ControllerState>, now: number, armed: boolean): void {
    this.stats.sent++;
    this.stats.lastSentAt = now;

    if (!armed) {
      // First disarmed packet: drop everything immediately (ignores min-hold).
      if (this.wasArmed) this.record(this.machine.releaseAll(now));
      this.wasArmed = false;
      this.record(this.machine.step(NEUTRAL_STATE, now));
      return;
    }
    this.wasArmed = true;

    copyState(state, this.scratch);
    enforceExclusivity(this.scratch, 'allow-both', DEFAULT_EXCLUSIVITY_THRESHOLD); // same as the loop: both pedals pass
    this.record(this.machine.step(this.scratch, now));
  }

  releaseAll(now: number, _reason: string): void {
    this.stats.releases++;
    this.wasArmed = false;
    this.record(this.machine.releaseAll(now));
  }

  configure(opts: OutputOptions): void {
    this.machine.setSteerPulse(opts.steerPulse);
  }

  /** Newest last. Allocates — call from the UI, not the loop. */
  recentEvents(): KeyEvent[] {
    const out: KeyEvent[] = [];
    for (let i = 0; i < LOG_SIZE; i++) {
      const e = this.log[(this.logHead + i) % LOG_SIZE]!;
      if (e.t >= 0) out.push({ ...e });
    }
    return out;
  }

  dispose(): void {
    this.releaseAll(performance.now(), 'dispose');
  }

  /** Copy events into the preallocated ring and refresh `keys`. No allocation. */
  private record(events: readonly KeyEvent[]): void {
    if (events.length === 0) return;
    for (const e of events) {
      const slot = this.log[this.logHead]!;
      slot.key = e.key;
      slot.down = e.down;
      slot.t = e.t;
      this.logHead = (this.logHead + 1) % LOG_SIZE;
    }
    this.machine.snapshot(this.keys);
    this.version++;
  }
}

/** Copy without allocating. Buttons: copy values, and clear any the source no longer has. */
function copyState(src: Readonly<ControllerState>, dst: ControllerState): void {
  dst.steering = src.steering;
  dst.throttle = src.throttle;
  dst.brake = src.brake;
  for (const id in dst.buttons) if (!(id in src.buttons)) dst.buttons[id] = false;
  for (const id in src.buttons) dst.buttons[id] = src.buttons[id] === true;
}
