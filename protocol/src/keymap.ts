/**
 * KeyStateMachine — turns ControllerState into key down / key up events.
 *
 * Runs in three places, and must behave IDENTICALLY in all of them:
 *   mock ESP32 (node) · tablet loopback (browser) · real ESP32 firmware (C++ port of this file)
 *
 *   ControllerState ──update()──► which keys SHOULD be down
 *                   ──tick()────► actual press/release events, respecting timing rules
 *
 * Three rules keep keys from flickering (plan.md §19.6 "no uncontrolled rapid keypress loops"):
 *   1. Hysteresis — press above 0.15, release only below 0.10.
 *      So a value sitting right at 0.15 doesn't press/release 100×/sec.
 *   2. Min hold — once down, a key stays down ≥ 30 ms. Short taps still register in-game.
 *   3. Min gap  — once up, a key stays up ≥ 20 ms.
 *   → Even garbage input can't press a key more than 1000/(30+20) = 20 times/sec.
 *
 * Safety: releaseAll() ignores rule 2. Stopping always wins.
 *
 * The caller decides WHEN to be neutral: when disarmed or disconnected, feed
 * NEUTRAL_STATE (or call releaseAll). This class only maps state → keys.
 */

import type { ActionId, ControllerState } from './controllerState';

/**
 * Key names use the browser's KeyboardEvent.code values ('KeyA', 'Space', 'ShiftLeft', …).
 * The firmware maps these names to USB HID usage codes.
 */
export type KeyCode = string;

export interface KeyEvent {
  key: KeyCode;
  down: boolean;
  t: number;
}

export interface KeyMapConfig {
  steerLeftKey: KeyCode;
  steerRightKey: KeyCode;
  throttleKey: KeyCode;
  brakeKey: KeyCode;
  /** Action name → key. Two sources may share a key; it's down if EITHER wants it. */
  actionKeys: Record<ActionId, KeyCode>;

  /** Steering presses its key above `steerOn`, releases below `steerOff`. */
  steerOn: number;
  steerOff: number;
  /** Same for throttle and brake. */
  pedalOn: number;
  pedalOff: number;

  minHoldMs: number;
  minGapMs: number;
}

/**
 * F1 25 on PS5, "Keyboard Preset 1" defaults — read off the game's Controls
 * screen and confirmed driving the car (F.3, 2026-09-24).
 * Note: NOT W/A/S/D. In this game A is accelerate and S is push-to-talk.
 * Full binding list: firmware/esp32/README.md.
 */
export const DEFAULT_KEYMAP: KeyMapConfig = {
  steerLeftKey: 'Comma',
  steerRightKey: 'Period',
  throttleKey: 'KeyA',
  brakeKey: 'KeyZ',
  actionKeys: {
    gearUp: 'Space',
    gearDown: 'ShiftLeft',
    drs: 'KeyF',
    ers: 'KeyM', //   F1 25 calls it "Overtake / Boost"
    mfd: 'Numpad0',
    radio: 'KeyT',
  },
  steerOn: 0.15,
  steerOff: 0.1,
  pedalOn: 0.15,
  pedalOff: 0.1,
  minHoldMs: 30,
  minGapMs: 20,
};

interface KeyState {
  /** What we're actually telling the host right now. */
  down: boolean;
  /** What the latest state asks for. */
  want: boolean;
  /** When `down` last changed. */
  changedAt: number;
}

export class KeyStateMachine {
  private cfg: KeyMapConfig;
  private readonly keys = new Map<KeyCode, KeyState>();
  /** Reused every tick so the 100 Hz loop doesn't allocate. */
  private readonly events: KeyEvent[] = [];

  // Hysteresis memory: is this input currently "on"?
  private leftOn = false;
  private rightOn = false;
  private throttleOn = false;
  private brakeOn = false;

  constructor(config: KeyMapConfig = DEFAULT_KEYMAP) {
    this.cfg = sanitize(config);
    this.buildKeys();
  }

  /**
   * Swap bindings. Everything is released first, so a key from the old map
   * can never be left held.
   */
  setConfig(config: KeyMapConfig, now: number): readonly KeyEvent[] {
    const events = this.releaseAll(now);
    const released = events.slice();
    this.cfg = sanitize(config);
    this.keys.clear();
    this.buildKeys();
    return released;
  }

  /** Work out which keys SHOULD be down. Produces no events on its own — call tick(). */
  update(s: Readonly<ControllerState>): void {
    const c = this.cfg;

    // Steering: one signed value, so left and right can never both be on.
    // NaN compares false everywhere → released, the safe default.
    this.leftOn = this.leftOn ? s.steering < -c.steerOff : s.steering < -c.steerOn;
    this.rightOn = this.rightOn ? s.steering > c.steerOff : s.steering > c.steerOn;
    this.throttleOn = this.throttleOn ? s.throttle > c.pedalOff : s.throttle > c.pedalOn;
    this.brakeOn = this.brakeOn ? s.brake > c.pedalOff : s.brake > c.pedalOn;

    for (const k of this.keys.values()) k.want = false;

    this.want(c.steerLeftKey, this.leftOn);
    this.want(c.steerRightKey, this.rightOn);
    this.want(c.throttleKey, this.throttleOn);
    this.want(c.brakeKey, this.brakeOn);
    for (const id in c.actionKeys) {
      this.want(c.actionKeys[id]!, s.buttons[id] === true);
    }
  }

  /**
   * Turn wants into real press/release events, respecting min hold / min gap.
   * Call regularly (every packet, and on a timer) so delayed releases happen.
   *
   * RELEASES ALWAYS COME BEFORE PRESSES within one tick. The firmware sends a
   * USB report per event, so steering right→left must go "▲ right, ▼ left" —
   * never "▼ left, ▲ right", which would briefly hold both at once.
   *
   * The returned array is REUSED — read it before the next call.
   */
  tick(now: number): readonly KeyEvent[] {
    const c = this.cfg;
    const events = this.events;
    events.length = 0;

    // Pass 1: releases.
    for (const [key, k] of this.keys) {
      if (!k.down || k.want) continue;
      if (now - k.changedAt < c.minHoldMs) continue; // held too briefly — release later
      k.down = false;
      k.changedAt = now;
      events.push({ key, down: false, t: now });
    }
    // Pass 2: presses.
    for (const [key, k] of this.keys) {
      if (k.down || !k.want) continue;
      if (now - k.changedAt < c.minGapMs) continue; // released too recently — press later
      k.down = true;
      k.changedAt = now;
      events.push({ key, down: true, t: now });
    }
    return events;
  }

  /** update() + tick() in one call. */
  step(s: Readonly<ControllerState>, now: number): readonly KeyEvent[] {
    this.update(s);
    return this.tick(now);
  }

  /**
   * Release every key RIGHT NOW, ignoring min hold. Used on disconnect,
   * watchdog timeout, disarm. Safe to call repeatedly.
   *
   * The returned array is REUSED — read it before the next call.
   */
  releaseAll(now: number): readonly KeyEvent[] {
    const events = this.events;
    events.length = 0;
    this.leftOn = this.rightOn = this.throttleOn = this.brakeOn = false;

    for (const [key, k] of this.keys) {
      k.want = false;
      if (!k.down) continue;
      k.down = false;
      k.changedAt = now;
      events.push({ key, down: false, t: now });
    }
    return events;
  }

  isDown(key: KeyCode): boolean {
    return this.keys.get(key)?.down ?? false;
  }

  /** Fill `out` with every bound key → down?. Pass the same object each time to avoid allocating. */
  snapshot(out: Record<KeyCode, boolean> = {}): Record<KeyCode, boolean> {
    for (const [key, k] of this.keys) out[key] = k.down;
    return out;
  }

  get config(): Readonly<KeyMapConfig> {
    return this.cfg;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private want(key: KeyCode, on: boolean): void {
    // OR, not assign: if two inputs share a key, either one keeps it down.
    if (on) this.keys.get(key)!.want = true;
  }

  private buildKeys(): void {
    const c = this.cfg;
    const all = [c.steerLeftKey, c.steerRightKey, c.throttleKey, c.brakeKey, ...Object.values(c.actionKeys)];
    for (const key of all) {
      if (!this.keys.has(key)) {
        // -Infinity: a key that has never been pressed may be pressed immediately.
        this.keys.set(key, { down: false, want: false, changedAt: -Infinity });
      }
    }
  }
}

/** Keep thresholds sane: 0 < on ≤ 1, 0 ≤ off ≤ on, timings ≥ 0. */
function sanitize(c: KeyMapConfig): KeyMapConfig {
  const on = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0.001), 1) : 0.15);
  const off = (v: number, onV: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), onV) : onV);
  const ms = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const steerOn = on(c.steerOn);
  const pedalOn = on(c.pedalOn);
  return {
    ...c,
    actionKeys: { ...c.actionKeys },
    steerOn,
    steerOff: off(c.steerOff, steerOn),
    pedalOn,
    pedalOff: off(c.pedalOff, pedalOn),
    minHoldMs: ms(c.minHoldMs),
    minGapMs: ms(c.minGapMs),
  };
}
