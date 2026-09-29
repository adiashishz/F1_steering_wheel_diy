/**
 * What the fingers are doing right now. Written by pointer handlers, read by
 * the 100 Hz loop. A plain mutable object: no React, no events.
 *
 *   throttle / brake   0 … 1 from the touch pads — analog, from finger height (pedalLevel)
 *   steerOverride      a fixed steering value while a test chip is held, else null
 *   buttons            action id → held (shift paddles, DRS, boost)
 *
 * Every pad remembers WHICH pointers are down, so two fingers on one pad, or a
 * finger lifting off a different pad, can't release it by mistake.
 */

import type { ActionId } from '@wheel/protocol';

export interface TouchState {
  throttle: number;
  brake: number;
  steerOverride: number | null;
  buttons: Record<ActionId, boolean>;
}

/**
 * Every action the tablet can send. Names only — which key each one becomes is
 * the output's business (DualSense: padBridge.ts DEFAULT_MAPPING · keyboard: keymap.ts).
 */
/** Work only while ARMED (the F1 screen). */
export const DRIVE_ACTIONS: readonly ActionId[] = ['gearUp', 'gearDown', 'drs', 'ers'];
/** Work only while DISARMED (the menu screen) — they can't drive the car. */
export const MENU_ACTIONS: readonly ActionId[] = [
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'menuSelect', // ✕
  'menuBack', //   ○
  'faceTriangle',
  'faceSquare',
  'l1',
  'r1',
  'l2', //         full pull (the drive screen's pedals are the analog ones)
  'r2',
  'l3', //         stick clicks
  'r3',
  'pause', //      Options
  'create', //     the "media" button left of the touchpad
  'ps',
];
export const ACTION_IDS: readonly ActionId[] = [...DRIVE_ACTIONS, ...MENU_ACTIONS];

export const touch: TouchState = {
  throttle: 0,
  brake: 0,
  steerOverride: null,
  buttons: Object.fromEntries(ACTION_IDS.map((id) => [id, false])),
};

/**
 * Called on every press / release. The control loop uses it to send a packet
 * RIGHT AWAY: Chrome defers page timers for up to ~200 ms after a finger lands
 * (touch gets priority), so waiting for the next 100 Hz tick lost quick taps and
 * delayed every press. Input handlers themselves are not deferred.
 */
const changeListeners = new Set<() => void>();
export function onTouchChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function changed(): void {
  for (const fn of changeListeners) fn();
}

type Pad = 'throttle' | 'brake';
/** Pointer id → its level, per pad. Two fingers on one pad → the deeper one counts. */
const held: Record<Pad, Map<number, number>> = { throttle: new Map(), brake: new Map() };
const padRelease: Record<Pad, ReturnType<typeof setTimeout> | undefined> = { throttle: undefined, brake: undefined };
/** When each pad was pressed (−Infinity = not held) — for MIN_TAP_MS. */
const padPressedAt: Record<Pad, number> = { throttle: -Infinity, brake: -Infinity };

/**
 * Finger height on a pad → pedal level, like how far a trigger is pulled:
 *   bottom edge → PEDAL_MIN (a touch always does something)
 *   rising      → linear
 *   top (1 − PEDAL_FULL_AT) of the pad → 100%
 * Quantised to PEDAL_STEP so a resting finger's jitter doesn't send a stream of changes.
 * `fromBottom` is 0 at the pad's bottom edge, 1 at its top (outside is clamped).
 */
export const PEDAL_MIN = 0.1;
export const PEDAL_FULL_AT = 0.8;
export const PEDAL_STEP = 0.02;
export function pedalLevel(fromBottom: number): number {
  const f = Math.min(Math.max(fromBottom, 0), 1);
  const v = PEDAL_MIN + ((1 - PEDAL_MIN) * f) / PEDAL_FULL_AT;
  return Math.min(1, Math.round(v / PEDAL_STEP) * PEDAL_STEP);
}

function applyPad(pad: Pad): void {
  let level = 0;
  for (const v of held[pad].values()) level = Math.max(level, v);
  if (level === touch[pad]) return;
  touch[pad] = level;
  changed();
}

export function padDown(pad: Pad, pointerId: number, level: number): void {
  clearTimeout(padRelease[pad]);
  padRelease[pad] = undefined;
  if (held[pad].size === 0 && touch[pad] === 0) padPressedAt[pad] = performance.now();
  held[pad].set(pointerId, level);
  applyPad(pad);
}

/** The finger slid: new level (only for a pointer that's down on this pad). */
export function padMove(pad: Pad, pointerId: number, level: number): void {
  if (!held[pad].has(pointerId)) return;
  held[pad].set(pointerId, level);
  applyPad(pad);
}

export function padUp(pad: Pad, pointerId: number): void {
  if (!held[pad].delete(pointerId)) return;
  if (held[pad].size > 0) return applyPad(pad); // another finger still on it
  // Same minimum as the buttons: a 30 ms tap still lasts MIN_TAP_MS, so the game sees it.
  const heldFor = performance.now() - padPressedAt[pad];
  const release = () => {
    padRelease[pad] = undefined;
    if (held[pad].size > 0) return;
    touch[pad] = 0;
    padPressedAt[pad] = -Infinity;
    changed();
  };
  if (heldFor >= MIN_TAP_MS) release();
  else padRelease[pad] = setTimeout(release, MIN_TAP_MS - heldFor);
}

const buttonPointers: Record<ActionId, Set<number>> = Object.fromEntries(ACTION_IDS.map((id) => [id, new Set<number>()]));

/**
 * A light tap can go down AND up between two 100 Hz loop ticks and never be
 * sent. So every press is held for at least this long, even if the finger has
 * already lifted: ~5 frames at 60 fps, enough for the game to see it.
 */
export const MIN_TAP_MS = 80;
const pressedAt: Record<ActionId, number> = {};
const pendingRelease: Record<ActionId, ReturnType<typeof setTimeout> | undefined> = {};

export function buttonDown(id: ActionId, pointerId: number): void {
  buttonPointers[id]?.add(pointerId);
  clearTimeout(pendingRelease[id]);
  pendingRelease[id] = undefined;
  pressedAt[id] = performance.now();
  touch.buttons[id] = true;
  changed();
}

export function buttonUp(id: ActionId, pointerId: number): void {
  const held = buttonPointers[id];
  held?.delete(pointerId);
  if (held && held.size > 0) return;
  const heldFor = performance.now() - (pressedAt[id] ?? -Infinity);
  if (heldFor >= MIN_TAP_MS) {
    touch.buttons[id] = false;
    changed();
    return;
  }
  clearTimeout(pendingRelease[id]);
  pendingRelease[id] = setTimeout(() => {
    pendingRelease[id] = undefined;
    if (!buttonPointers[id] || buttonPointers[id]!.size === 0) {
      touch.buttons[id] = false;
      changed();
    }
  }, MIN_TAP_MS - heldFor);
}

/** Nothing pressed on the screen (steering from the gyro doesn't count). */
export function touchIsNeutral(): boolean {
  if (touch.throttle > 0 || touch.brake > 0 || touch.steerOverride !== null) return false;
  for (const id in touch.buttons) if (touch.buttons[id]) return false;
  return true;
}

let overridePointer: number | null = null;

export function steerOverrideDown(value: number, pointerId: number): void {
  overridePointer = pointerId;
  touch.steerOverride = value;
}

export function steerOverrideUp(pointerId: number): void {
  if (overridePointer !== pointerId) return;
  overridePointer = null;
  touch.steerOverride = null;
}

/** Let go of everything. Used by the release guards. */
export function releaseAllTouch(): void {
  held.throttle.clear();
  held.brake.clear();
  clearTimeout(padRelease.throttle);
  clearTimeout(padRelease.brake);
  padRelease.throttle = padRelease.brake = undefined;
  padPressedAt.throttle = padPressedAt.brake = -Infinity;
  touch.throttle = 0;
  touch.brake = 0;
  overridePointer = null;
  touch.steerOverride = null;
  for (const id of ACTION_IDS) {
    buttonPointers[id]!.clear();
    clearTimeout(pendingRelease[id]); // safety beats the minimum tap: release NOW
    pendingRelease[id] = undefined;
    touch.buttons[id] = false;
  }
  changed();
}
