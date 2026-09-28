/**
 * OutputDevice — THE SEAM (plan.md §15).
 *
 *   everything before this      ControllerState (steering, throttle, brake, buttons)
 *   ─────────────────────────── ▼ send()
 *   an OutputDevice             turns it into something real
 *
 * Implementations:
 *   NullOutput       drops everything (safe default)
 *   LoopbackOutput   runs the real key logic in the browser — no server, no ESP32
 *   WebSocketOutput  sends to the ESP32 (or the mock server)
 *   later, if ever:  GamepadOutput, AccessControllerOutput
 *
 * Swapping one for another is a one-line change in core/runtime.ts. Nothing
 * before this point knows which one is plugged in.
 */

import type { ControllerState, SteerPulseConfig } from '@wheel/protocol';

/**
 * Output-side tuning pushed down from settings. Keyboard-specific on purpose —
 * outputs that don't care (null, a future gamepad) just ignore it.
 */
export interface OutputOptions {
  steerPulse: SteerPulseConfig;
}

export interface OutputStats {
  /** send() calls accepted. */
  sent: number;
  /** send() calls that couldn't be delivered (not ready, backpressure …). */
  dropped: number;
  /** releaseAll() calls. */
  releases: number;
  lastSentAt: number;
}

export interface OutputDevice {
  readonly id: string;
  readonly label: string;
  /** Can this output deliver right now? (Loopback: always. WebSocket: only when connected.) */
  readonly ready: boolean;
  readonly stats: Readonly<OutputStats>;

  /**
   * Hot path — called every control tick.
   * `armed: false` → the output must behave as if everything is released.
   * Must not keep a reference to `state`; the loop reuses that object.
   */
  send(state: Readonly<ControllerState>, now: number, armed: boolean): void;

  /** Release everything immediately. Idempotent — safe to call repeatedly. */
  releaseAll(now: number, reason: string): void;

  /** Apply output tuning. Called once at start and on every settings change. */
  configure(opts: OutputOptions): void;

  dispose(): void;
}

export function createOutputStats(): OutputStats {
  return { sent: 0, dropped: 0, releases: 0, lastSentAt: 0 };
}
