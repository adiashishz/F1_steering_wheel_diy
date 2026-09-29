/**
 * What the fingers are doing right now. Written by pointer handlers, read by
 * the 100 Hz loop. A plain mutable object: no React, no events.
 *
 *   throttle / brake   0 … 1 from the touch pads (digital for now: 0 or 1)
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
  'pause', //      Options
];
export const ACTION_IDS: readonly ActionId[] = [...DRIVE_ACTIONS, ...MENU_ACTIONS];

export const touch: TouchState = {
  throttle: 0,
  brake: 0,
  steerOverride: null,
  buttons: Object.fromEntries(ACTION_IDS.map((id) => [id, false])),
};

type Pad = 'throttle' | 'brake';
const held: Record<Pad, Set<number>> = { throttle: new Set(), brake: new Set() };

export function padDown(pad: Pad, pointerId: number): void {
  held[pad].add(pointerId);
  touch[pad] = 1;
}

export function padUp(pad: Pad, pointerId: number): void {
  held[pad].delete(pointerId);
  if (held[pad].size === 0) touch[pad] = 0;
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
}

export function buttonUp(id: ActionId, pointerId: number): void {
  const held = buttonPointers[id];
  held?.delete(pointerId);
  if (held && held.size > 0) return;
  const heldFor = performance.now() - (pressedAt[id] ?? -Infinity);
  if (heldFor >= MIN_TAP_MS) {
    touch.buttons[id] = false;
    return;
  }
  clearTimeout(pendingRelease[id]);
  pendingRelease[id] = setTimeout(() => {
    pendingRelease[id] = undefined;
    if (!buttonPointers[id] || buttonPointers[id]!.size === 0) touch.buttons[id] = false;
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
}
