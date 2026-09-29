/**
 * PadBridge — ControllerState → a DualSense, via the ESP32 `pad_bridge` firmware on USB serial.
 *
 *   Device.output() ──map()──► pad { sticks, triggers, hat, buttons } ──"P …\n"──► /dev/cu.usbmodem…
 *                                                                                    │ ESP32 renders it as a
 *                                                          PS Remote Play ◄── DualSense ┘ USB HID report
 *
 * All mapping lives HERE, so changing which stick steers or which button is DRS
 * is a restart, never a reflash. Sends on every change and at least every 50 ms
 * (the ESP32 centres everything after 250 ms without a line).
 *
 * No native serial library: the ESP32's port is USB CDC, so the baud rate is
 * irrelevant — `stty raw` once, then plain file reads and writes. If the board
 * is unplugged the port disappears; we close it and keep retrying.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, writeSync, createReadStream, type ReadStream } from 'node:fs';
import type { ControllerState } from '@wheel/protocol';
import { log } from './log';

/** DualSense button bits, as the pad_bridge firmware expects (BTN_* in dualsense.h). */
export const DS_BUTTONS = {
  square: 1 << 4,
  cross: 1 << 5,
  circle: 1 << 6,
  triangle: 1 << 7,
  l1: 1 << 8,
  r1: 1 << 9,
  l2: 1 << 10,
  r2: 1 << 11,
  create: 1 << 12,
  options: 1 << 13,
  l3: 1 << 14,
  r3: 1 << 15,
  ps: 1 << 16,
  touchpad: 1 << 17,
} as const;
export type DsButton = keyof typeof DS_BUTTONS;

export interface PadMapping {
  /** Which stick's X axis steers. F1 25 default: left. */
  steerStick: 'left' | 'right';
  /** Tablet action id → DualSense button. Check against F1 25's Controls screen. */
  actions: Record<string, DsButton>;
}

/**
 * F1 25's default DualSense layout (steer left stick, R2 / L2 pedals). The menu
 * actions are the PS5's own: ✕ select, ○ back, Options = pause.
 * Override with --map=gearUp:cross,gearDown:square,…
 */
export const DEFAULT_MAPPING: PadMapping = {
  steerStick: 'left',
  actions: {
    gearUp: 'cross',
    gearDown: 'square',
    drs: 'triangle',
    ers: 'circle',
    menuSelect: 'cross',
    menuBack: 'circle',
    faceTriangle: 'triangle',
    faceSquare: 'square',
    l1: 'l1',
    r1: 'r1',
    pause: 'options',
  },
};

/** D-pad actions become the hat switch, not buttons. */
const DPAD = { up: 'dpadUp', down: 'dpadDown', left: 'dpadLeft', right: 'dpadRight' } as const;

const HEARTBEAT_MS = 50;
const RETRY_MS = 1000;

interface Pad {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  l2: number;
  r2: number;
  hat: number;
  buttons: number;
}

export class PadBridge {
  private fd: number | null = null;
  private reader: ReadStream | null = null;
  private path = '';
  private lastLine = '';
  private lastSentAt = 0;
  private lastRetryAt = -Infinity;
  private espBuf = '';
  /** Lines written in the current second, for the status line. */
  linesThisSecond = 0;
  linesPerSec = 0;
  readonly pad: Pad = { lx: 128, ly: 128, rx: 128, ry: 128, l2: 0, r2: 0, hat: 8, buttons: 0 };

  constructor(
    private readonly portArg: string,
    readonly mapping: PadMapping,
  ) {}

  get connected(): boolean {
    return this.fd !== null;
  }

  get port(): string {
    return this.path;
  }

  /** Call every tick with what the output should be right now (neutral when not armed / not live). */
  update(state: Readonly<ControllerState>, now: number): void {
    if (this.fd === null) {
      if (now - this.lastRetryAt >= RETRY_MS) this.open(now);
      return;
    }
    this.map(state);
    const p = this.pad;
    this.logChanges();
    const line = `P ${p.lx} ${p.ly} ${p.rx} ${p.ry} ${p.l2} ${p.r2} ${p.hat} ${p.buttons}\n`;
    if (line === this.lastLine && now - this.lastSentAt < HEARTBEAT_MS) return;
    try {
      writeSync(this.fd, line);
      this.lastLine = line;
      this.lastSentAt = now;
      this.linesThisSecond++;
    } catch (e) {
      log('pad', `write to ${this.path} failed (${(e as Error).message}) — board unplugged? retrying`);
      this.close();
    }
  }

  /** Buttons / triggers currently held, by name — for the tablet's status line. */
  held(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const name of Object.keys(DS_BUTTONS) as DsButton[]) out[name] = (this.pad.buttons & DS_BUTTONS[name]) !== 0;
    return out;
  }

  tickSecond(): void {
    this.linesPerSec = this.linesThisSecond;
    this.linesThisSecond = 0;
  }

  close(): void {
    this.reader?.destroy();
    this.reader = null;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already gone */
      }
    }
    this.fd = null;
    this.lastLine = '';
  }

  /** Centre everything on the ESP32 before exiting (best effort). */
  centreAndClose(): void {
    if (this.fd !== null) {
      try {
        writeSync(this.fd, 'P 128 128 128 128 0 0 8 0\n');
      } catch {
        /* ignore */
      }
    }
    this.close();
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private prevButtons = 0;
  private prevHat = 8;

  /** One line per button / D-pad change, so a quick tap is never lost between the 1 s summaries. */
  private logChanges(): void {
    const p = this.pad;
    const changed = p.buttons ^ this.prevButtons;
    if (changed) {
      for (const name of Object.keys(DS_BUTTONS) as DsButton[]) {
        const bit = DS_BUTTONS[name];
        if (changed & bit) log('pad', `${name} ${p.buttons & bit ? '▼ down' : '▲ up'}`);
      }
      this.prevButtons = p.buttons;
    }
    if (p.hat !== this.prevHat) {
      log('pad', `d-pad ${HAT_NAMES[p.hat] ?? p.hat}`);
      this.prevHat = p.hat;
    }
  }

  private map(s: Readonly<ControllerState>): void {
    const p = this.pad;
    const x = clampByte(128 + Math.round(clamp(s.steering, -1, 1) * 127));
    p.lx = this.mapping.steerStick === 'left' ? x : 128;
    p.rx = this.mapping.steerStick === 'right' ? x : 128;
    p.ly = 128;
    p.ry = 128;
    p.r2 = clampByte(Math.round(clamp(s.throttle, 0, 1) * 255));
    p.l2 = clampByte(Math.round(clamp(s.brake, 0, 1) * 255));
    p.hat = hatFrom(
      s.buttons[DPAD.up] === true,
      s.buttons[DPAD.down] === true,
      s.buttons[DPAD.left] === true,
      s.buttons[DPAD.right] === true,
    );
    let b = 0;
    // A real DualSense also sets the L2/R2 digital bits while the trigger is pulled.
    if (p.r2 > 0) b |= DS_BUTTONS.r2;
    if (p.l2 > 0) b |= DS_BUTTONS.l2;
    for (const id in s.buttons) {
      const btn = this.mapping.actions[id];
      if (btn && s.buttons[id]) b |= DS_BUTTONS[btn];
    }
    p.buttons = b;
  }

  private open(now: number): void {
    this.lastRetryAt = now;
    const path = this.portArg === 'auto' ? findPort() : this.portArg;
    if (!path) return;
    try {
      this.fd = openSync(path, 'r+');
      // Set raw / no-echo on THIS open descriptor (settings made by a separate
      // `stty -f` can be reset on close). Echo would bounce the board's log text
      // back to it, and a stray letter in a log line is a debug command there.
      execFileSync('stty', ['raw', '-echo'], { stdio: [this.fd, 'ignore', 'ignore'] });
    } catch (e) {
      if (this.path !== path) log('pad', `can't open ${path}: ${(e as Error).message}`);
      this.path = path;
      return;
    }
    this.path = path;
    log('pad', `ESP32 pad_bridge on ${path} · steering on ${this.mapping.steerStick} stick · ${fmtActions(this.mapping)}`);
    // Echo the board's own log lines, so its watchdog / summary show up here too.
    this.reader = createReadStream('', { fd: this.fd, autoClose: false });
    this.reader.on('data', (chunk) => {
      this.espBuf += chunk.toString();
      let i;
      while ((i = this.espBuf.indexOf('\n')) >= 0) {
        const line = this.espBuf.slice(0, i).trim();
        this.espBuf = this.espBuf.slice(i + 1);
        if (line && !/lines\/s/.test(line)) log('esp32', line);
      }
    });
    this.reader.on('error', () => this.close());
  }
}

const HAT_NAMES = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'released'];

/** D-pad → hat: 0 = up, 1 = up-right … 7 = up-left, 8 = released. Opposites cancel. */
function hatFrom(up: boolean, down: boolean, left: boolean, right: boolean): number {
  const v = (up ? 1 : 0) - (down ? 1 : 0);
  const h = (right ? 1 : 0) - (left ? 1 : 0);
  if (v === 1) return h === 0 ? 0 : h === 1 ? 1 : 7;
  if (v === -1) return h === 0 ? 4 : h === 1 ? 3 : 5;
  return h === 1 ? 2 : h === -1 ? 6 : 8;
}

/** The ESP32's USB CDC port. In upload mode it's usbmodem1101-style; running firmware is usbmodem<serial>. */
function findPort(): string | undefined {
  const ports = readdirSync('/dev').filter((n) => n.startsWith('cu.usbmodem'));
  return ports.length ? `/dev/${ports[0]}` : undefined;
}

/** --map=gearUp:cross,drs:r1 → merged into the defaults. Unknown buttons are rejected loudly. */
export function parseMapping(arg: string | undefined, steer: string | undefined): PadMapping {
  const m: PadMapping = { steerStick: steer === 'right' ? 'right' : 'left', actions: { ...DEFAULT_MAPPING.actions } };
  if (!arg) return m;
  for (const pair of arg.split(',')) {
    const [id, btn] = pair.split(':');
    if (!id || !btn || !(btn in DS_BUTTONS)) throw new Error(`--map: bad entry "${pair}" (buttons: ${Object.keys(DS_BUTTONS).join(' ')})`);
    m.actions[id] = btn as DsButton;
  }
  return m;
}

function fmtActions(m: PadMapping): string {
  return Object.entries(m.actions)
    .map(([id, b]) => `${id}→${b}`)
    .join(' ');
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : 0);
const clampByte = (v: number) => Math.min(Math.max(v, 0), 255);
