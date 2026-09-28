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
 * Steering can optionally PULSE instead of hold (`steerPulse.mode`, the live lock test):
 *   'hold'   key down while past the threshold → full lock in F1 25 (the default)
 *   'pwm'    fixed period, on-time = duty × period            duty = |steering| / fullAt
 *   'sigma'  switches as fast as minPulseMs allows, keeping the running average = duty
 * Pulse timing lives HERE (on the ESP32), never on the tablet — Wi-Fi jitter would smear it.
 * In the pulse modes the steer keys skip min hold / min gap; `minPulseMs` replaces them.
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

export type SteerMode = 'hold' | 'pwm' | 'sigma';
export const STEER_MODES: readonly SteerMode[] = ['hold', 'pwm', 'sigma'];

export interface SteerPulseConfig {
  mode: SteerMode;
  /** pwm: length of one on + off cycle. */
  periodMs: number;
  /** pwm + sigma: shortest press AND shortest gap. Caps presses at 1000 / (2 × this) per second. */
  minPulseMs: number;
  /** |steering| at or above this → full duty. Below it, duty = |steering| / fullAt. */
  fullAt: number;
  /** Duty at full steering. 1 → held solid there; lower keeps pulsing even at full tilt. */
  maxDuty: number;
}

/** Allowed ranges. Wire values outside these are rejected (codec.ts); local ones are clamped. */
export const STEER_PULSE_LIMITS = {
  periodMs: { min: 10, max: 500 },
  // 4 ms ≥ 4 USB polls (the ESP32 keyboard polls at 1 ms), so every press reaches the PS5.
  minPulseMs: { min: 4, max: 100 },
  fullAt: { min: 0.3, max: 1 },
  maxDuty: { min: 0.05, max: 1 },
} as const;

export const DEFAULT_STEER_PULSE: SteerPulseConfig = {
  mode: 'hold',
  periodMs: 40,
  minPulseMs: 10,
  fullAt: 0.95,
  maxDuty: 1,
};

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

  /** How steering expresses part-way values. 'hold' = plain on/off. */
  steerPulse: SteerPulseConfig;
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
  steerPulse: DEFAULT_STEER_PULSE,
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

  // Pulse steering: direction (−1/0/+1) and size from the latest update(); timing state for tick().
  private steerDir = 0;
  private steerMag = 0;
  private pulseDir = 0;
  private pulseOn = false;
  private pulseChangedAt = -Infinity;
  /** sigma: ms of "owed" key-down time. + → press soon, − → release soon. */
  private pulseErr = 0;
  private pulseLastT = NaN;
  private duty = 0;

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

  /**
   * Change only the steering pulse settings. Unlike setConfig this does NOT
   * release everything, so the period can be tuned while a test is running.
   */
  setSteerPulse(p: SteerPulseConfig): void {
    this.cfg = { ...this.cfg, steerPulse: sanitizeSteerPulse(p) };
    this.resetPulse();
  }

  /** Duty the steering keys are running at: 0 … 1. 'hold' mode reports 0 or 1. */
  get steerDuty(): number {
    return this.duty;
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

    this.steerDir = this.leftOn ? -1 : this.rightOn ? 1 : 0;
    this.steerMag = this.steerDir === 0 ? 0 : Math.min(Math.abs(s.steering), 1);

    for (const k of this.keys.values()) k.want = false;

    if (c.steerPulse.mode === 'hold') {
      this.want(c.steerLeftKey, this.leftOn);
      this.want(c.steerRightKey, this.rightOn);
      this.duty = this.steerDir === 0 ? 0 : 1;
    }
    // Pulse modes: tick() sets the steer keys, because pulses change between packets.
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

    const pulsing = c.steerPulse.mode !== 'hold';
    if (pulsing) {
      const on = this.runPulser(now);
      this.keys.get(c.steerLeftKey)!.want = on && this.steerDir < 0;
      this.keys.get(c.steerRightKey)!.want = on && this.steerDir > 0;
    }

    // Pass 1: releases.
    for (const [key, k] of this.keys) {
      if (!k.down || k.want) continue;
      const exempt = pulsing && (key === c.steerLeftKey || key === c.steerRightKey);
      if (!exempt && now - k.changedAt < c.minHoldMs) continue; // held too briefly — release later
      k.down = false;
      k.changedAt = now;
      events.push({ key, down: false, t: now });
    }
    // Pass 2: presses.
    for (const [key, k] of this.keys) {
      if (k.down || !k.want) continue;
      const exempt = pulsing && (key === c.steerLeftKey || key === c.steerRightKey);
      if (!exempt && now - k.changedAt < c.minGapMs) continue; // released too recently — press later
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
    this.steerDir = 0;
    this.steerMag = 0;
    this.resetPulse();

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

  /**
   * Should the active steer key be down right now? Called every tick in pulse modes.
   *
   *   duty = min(|steering| / fullAt, 1) × maxDuty       ≥ 1 → hold solid
   *   pwm:   on = duty × period, off = period − on, each ≥ minPulseMs
   *          (no room for a ≥ minPulseMs gap → hold solid)
   *   sigma: owe += (duty − on) × dt;  after ≥ minPulseMs in a state,
   *          press when owed time ≥ 0, release when ≤ 0
   */
  private runPulser(now: number): boolean {
    const p = this.cfg.steerPulse;
    // Cap dt so a long pause between ticks can't build up a huge debt.
    const dt = Number.isNaN(this.pulseLastT) ? 0 : Math.min(Math.max(now - this.pulseLastT, 0), 50);
    this.pulseLastT = now;

    if (this.steerDir === 0) {
      this.resetPulse();
      this.pulseLastT = now;
      return false;
    }
    if (this.steerDir !== this.pulseDir) {
      // New direction: start a fresh pulse train.
      this.resetPulse();
      this.pulseLastT = now;
      this.pulseDir = this.steerDir;
    }

    const duty = Math.min(this.steerMag / p.fullAt, 1) * p.maxDuty;
    this.duty = duty;
    if (duty >= 1) return this.setPulse(true, now);

    const held = now - this.pulseChangedAt;
    const min = p.minPulseMs;

    if (p.mode === 'pwm') {
      const onMs = Math.max(duty * p.periodMs, min);
      const offMs = p.periodMs - onMs;
      if (offMs < min) return this.setPulse(true, now);
      if (this.pulseOn ? held >= onMs : held >= offMs) this.setPulse(!this.pulseOn, now);
      return this.pulseOn;
    }

    // sigma
    const limit = 10 * min;
    this.pulseErr = Math.min(Math.max(this.pulseErr + (duty - (this.pulseOn ? 1 : 0)) * dt, -limit), limit);
    if (held >= min) {
      if (this.pulseOn && this.pulseErr <= 0) this.setPulse(false, now);
      else if (!this.pulseOn && this.pulseErr >= 0) this.setPulse(true, now);
    }
    return this.pulseOn;
  }

  private setPulse(on: boolean, now: number): boolean {
    if (on !== this.pulseOn) {
      this.pulseOn = on;
      this.pulseChangedAt = now;
    }
    return on;
  }

  private resetPulse(): void {
    this.pulseDir = 0;
    this.pulseOn = false;
    // -Infinity: the first pulse of a new train may start immediately.
    this.pulseChangedAt = -Infinity;
    this.pulseErr = 0;
    this.pulseLastT = NaN;
    this.duty = 0;
  }

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
    steerPulse: sanitizeSteerPulse(c.steerPulse ?? DEFAULT_STEER_PULSE),
  };
}

/** Clamp pulse settings into STEER_PULSE_LIMITS; unknown mode → 'hold'. */
export function sanitizeSteerPulse(p: SteerPulseConfig): SteerPulseConfig {
  const L = STEER_PULSE_LIMITS;
  const fit = (v: number, r: { min: number; max: number }, fallback: number) =>
    Number.isFinite(v) ? Math.min(Math.max(v, r.min), r.max) : fallback;
  return {
    mode: STEER_MODES.includes(p.mode) ? p.mode : 'hold',
    periodMs: fit(p.periodMs, L.periodMs, DEFAULT_STEER_PULSE.periodMs),
    minPulseMs: fit(p.minPulseMs, L.minPulseMs, DEFAULT_STEER_PULSE.minPulseMs),
    fullAt: fit(p.fullAt, L.fullAt, DEFAULT_STEER_PULSE.fullAt),
    maxDuty: fit(p.maxDuty ?? 1, L.maxDuty, DEFAULT_STEER_PULSE.maxDuty),
  };
}
