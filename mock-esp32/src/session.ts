/**
 * Device — what the real ESP32 firmware does, in Node.
 *
 *   socket ──text──► handle() ──decodeClient──► hello / state / output_config / ping / bye
 *                                                   │
 *                        state (LIVE only) ──► exclusivity ──► KeyStateMachine.update()
 *   tick() every 1 ms ──► machine.tick() ──► key down / up   ("the USB keyboard")
 *                     └─► watchdog: no valid state for 300 ms → releaseAll, TRIPPED
 *
 * ONE keyboard, ONE active session. A new hello (from any socket) releases
 * everything and replaces the old session. Connection states are the ones in
 * controller-state.md §2:
 *
 *   PENDING ──hello──► AWAITING_FRESH ──state seq 0──► LIVE ──300 ms silence──► TRIPPED
 *      ▲                                                                         │
 *      └──────────────────────────── next hello ◄────────────────────────────────┘
 *
 * Outside LIVE every key is released. Stopping always wins: disconnect, bye,
 * disarm and watchdog all call releaseAll(), which ignores min hold.
 */

import {
  DEFAULT_EXCLUSIVITY_THRESHOLD,
  DEFAULT_KEYMAP,
  DEFAULT_STEER_PULSE,
  KeyStateMachine,
  NEUTRAL_STATE,
  PROTOCOL_VERSION,
  decodeClient,
  encodeServer,
  enforceExclusivity,
  type ErrorCode,
  type KeyEvent,
  type ServerMessage,
  type StateMessage,
  type StatusMessage,
  type SteerPulseConfig,
} from '@wheel/protocol';
import type { WebSocket } from 'ws';
import { log } from './log';

export const SERVER_INFO = { name: 'mock-esp32', version: '0.1.0' };
export const WATCHDOG_MS = 300; // matches wheel_link: 150 tripped on real Wi-Fi jitter
export const MAX_SEND_RATE_HZ = 100;
/** Non-fatal errors of one code are sent at most this often per socket, so a bad stream can't flood. */
const ERROR_REPEAT_MS = 1000;

export type LinkState = 'PENDING' | 'AWAITING_FRESH' | 'LIVE' | 'TRIPPED';

/** Counts events in the last second. */
class RateWindow {
  private times: number[] = [];
  push(t: number): void {
    this.times.push(t);
  }
  count(now: number): number {
    while (this.times.length > 0 && now - this.times[0]! > 1000) this.times.shift();
    return this.times.length;
  }
  clear(): void {
    this.times.length = 0;
  }
}

export class Device {
  readonly machine = new KeyStateMachine(DEFAULT_KEYMAP);

  // Active session. `socket` null → nobody connected (or nobody said hello).
  private socket: WebSocket | null = null;
  private sessionId = '';
  private client = '';
  state: LinkState = 'PENDING';
  private lastSeq = -1;
  private lastValidAt = 0;
  private dropped = 0;
  private armed = false;
  private steering = 0;
  private steerPulse: SteerPulseConfig = DEFAULT_STEER_PULSE;
  private readonly packets = new RateWindow();
  private readonly steerPresses = new RateWindow();

  /** socket → code → last time that error was sent. */
  private readonly lastError = new WeakMap<WebSocket, Map<ErrorCode, number>>();
  private readonly keysOut: Record<string, boolean> = {};

  constructor(private readonly printKeys: boolean) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  // ─── incoming ─────────────────────────────────────────────────────────────

  handle(ws: WebSocket, raw: string, now: number): void {
    const r = decodeClient(raw);
    if (!r.ok) {
      if (r.error.code === 'version') {
        log('error', `fatal: ${r.error.message}`);
        this.sendError(ws, 'version', r.error.message, true, now);
        ws.close(4001, 'unsupported protocol version');
        return;
      }
      this.sendError(ws, 'malformed', r.error.message, false, now);
      return;
    }

    const msg = r.msg;
    switch (msg.type) {
      case 'ping':
        // Answered on any socket, even before hello — it's harmless.
        this.send(ws, {
          type: 'pong',
          version: PROTOCOL_VERSION,
          id: msg.id,
          clientTimestamp: msg.timestamp,
          serverTimestamp: now,
        });
        return;

      case 'hello': {
        if (this.socket && this.socket !== ws) {
          log('session', `replaced by a new hello — closing the old socket`);
          const old = this.socket;
          this.endSession(now);
          old.close(4000, 'replaced by a new session');
        } else {
          this.emit(this.machine.releaseAll(now));
        }
        this.socket = ws;
        this.sessionId = msg.sessionId;
        this.client = `${msg.client.app} ${msg.client.appVersion}`;
        this.state = 'AWAITING_FRESH';
        this.lastSeq = -1;
        this.dropped = 0;
        this.armed = false;
        this.steering = 0;
        this.packets.clear();
        this.steerPresses.clear();
        this.steerPulse = DEFAULT_STEER_PULSE; // until output_config arrives
        this.machine.setSteerPulse(this.steerPulse);
        this.send(ws, {
          type: 'hello_ack',
          version: PROTOCOL_VERSION,
          accepted: true,
          server: SERVER_INFO,
          watchdogMs: WATCHDOG_MS,
          maxSendRateHz: MAX_SEND_RATE_HZ,
          serverTime: now,
        });
        log(
          'hello',
          `${this.client} · mode ${msg.mode} · ${msg.desiredSendRateHz} Hz · session ${msg.sessionId.slice(0, 8)} · actions ${msg.actionIds.join(',')}`,
        );
        return;
      }

      case 'output_config': {
        if (ws !== this.socket) {
          this.sendError(ws, 'handshake', 'output_config before hello', false, now);
          return;
        }
        const p = msg.steerPulse;
        this.steerPulse = { mode: p.mode, periodMs: p.periodMs, minPulseMs: p.minPulseMs, fullAt: p.fullAt, maxDuty: p.maxDuty ?? 1 };
        this.machine.setSteerPulse(this.steerPulse); // does NOT release keys
        log('config', `steer ${fmtPulse(this.steerPulse)}`);
        return;
      }

      case 'state':
        this.onState(ws, msg, now);
        return;

      case 'bye':
        if (ws === this.socket) {
          log('bye', msg.reason || '(no reason)');
          this.endSession(now);
        }
        return;
    }
  }

  private onState(ws: WebSocket, s: StateMessage, now: number): void {
    if (ws !== this.socket) {
      this.sendError(ws, 'handshake', 'state before hello', false, now);
      return;
    }
    if (s.sessionId !== this.sessionId) {
      this.dropped++;
      this.sendError(ws, 'stale', `state for session ${s.sessionId.slice(0, 8)}, current is ${this.sessionId.slice(0, 8)}`, false, now);
      return;
    }
    if (this.state === 'TRIPPED') return; // released until the next hello

    if (this.state === 'AWAITING_FRESH') {
      if (s.seq !== 0) {
        this.dropped++;
        return;
      }
      this.state = 'LIVE';
      log('live', 'seq 0 received — output follows state');
    } else if (s.seq <= this.lastSeq) {
      this.dropped++; // old or duplicate
      return;
    } else {
      this.dropped += s.seq - this.lastSeq - 1; // gap = lost on the way
    }

    this.lastSeq = s.seq;
    this.lastValidAt = now;
    this.packets.push(now);
    this.steering = s.steering;

    if (!s.armed) {
      if (this.armed) this.emit(this.machine.releaseAll(now));
      this.armed = false;
      this.machine.update(NEUTRAL_STATE);
    } else {
      this.armed = true;
      // The tablet already did this; do it again so a buggy tablet can't hold both pedals.
      enforceExclusivity(s, 'dominant', DEFAULT_EXCLUSIVITY_THRESHOLD);
      this.machine.update(s);
    }
    this.emit(this.machine.tick(now));
  }

  /** Socket closed. Only matters if it was the active one. */
  onClose(ws: WebSocket, now: number): void {
    if (ws !== this.socket) return;
    log('disconnect', `${this.client} — all keys released`);
    this.endSession(now);
  }

  // ─── 1 ms loop ────────────────────────────────────────────────────────────

  tick(now: number): void {
    if (this.state === 'LIVE' && now - this.lastValidAt > WATCHDOG_MS) {
      this.emit(this.machine.releaseAll(now));
      this.state = 'TRIPPED';
      this.armed = false;
      log('watchdog', `no valid state for ${Math.round(now - this.lastValidAt)} ms — all keys released, TRIPPED until next hello`);
      return;
    }
    this.emit(this.machine.tick(now));
  }

  // ─── outgoing ─────────────────────────────────────────────────────────────

  status(now: number): StatusMessage {
    return {
      type: 'status',
      version: PROTOCOL_VERSION,
      lastSeq: this.lastSeq,
      packetsPerSec: this.packets.count(now),
      droppedPackets: this.dropped,
      outputArmed: this.state === 'LIVE' && this.armed,
      watchdogTripped: this.state === 'TRIPPED',
      keys: this.machine.snapshot(this.keysOut),
      steerDuty: this.machine.steerDuty,
      steerPressesPerSec: this.steerPresses.count(now),
    };
  }

  sendStatus(now: number): void {
    if (this.socket) this.send(this.socket, this.status(now));
  }

  /** Everything /status shows over HTTP. */
  info(now: number): object {
    return {
      connected: this.connected,
      state: this.state,
      client: this.client || null,
      sessionId: this.sessionId || null,
      steering: this.steering,
      steerPulse: this.steerPulse,
      ...this.status(now),
    };
  }

  /** The once-a-second console line. */
  summary(now: number): string {
    const st = this.status(now);
    const held = Object.keys(st.keys).filter((k) => st.keys[k]);
    const arm = this.state === 'LIVE' ? (this.armed ? 'ARMED' : 'disarmed') : this.state;
    const steer = (this.steering >= 0 ? '+' : '') + this.steering.toFixed(2);
    return (
      `${String(st.packetsPerSec).padStart(3)} pkt/s · ${arm} · steer ${steer} · ` +
      `${this.steerPulse.mode} duty ${Math.round(this.machine.steerDuty * 100)}% · ` +
      `${st.steerPressesPerSec} presses/s · drop ${st.droppedPackets} · held [${held.join(' ')}]`
    );
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private endSession(now: number): void {
    this.emit(this.machine.releaseAll(now));
    this.socket = null;
    this.sessionId = '';
    this.client = '';
    this.state = 'PENDING';
    this.armed = false;
    this.steering = 0;
  }

  /** "Send" key events to the USB keyboard: here, count steer presses and maybe print. */
  private emit(events: readonly KeyEvent[]): void {
    const c = this.machine.config;
    for (const e of events) {
      if (e.down && (e.key === c.steerLeftKey || e.key === c.steerRightKey)) this.steerPresses.push(e.t);
      if (this.printKeys) log('key', `${e.down ? '▼' : '▲'} ${e.key}`);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(encodeServer(msg));
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string, fatal: boolean, now: number): void {
    let byCode = this.lastError.get(ws);
    if (!byCode) this.lastError.set(ws, (byCode = new Map()));
    if (!fatal && now - (byCode.get(code) ?? -Infinity) < ERROR_REPEAT_MS) return;
    byCode.set(code, now);
    if (!fatal) log('error', `${code}: ${message}`);
    this.send(ws, { type: 'error', version: PROTOCOL_VERSION, code, message, fatal });
  }
}

function fmtPulse(p: SteerPulseConfig): string {
  if (p.mode === 'hold') return 'hold';
  const period = p.mode === 'pwm' ? ` period ${p.periodMs} ms ·` : '';
  return `${p.mode} ·${period} min pulse ${p.minPulseMs} ms · full at ${p.fullAt} · max duty ${p.maxDuty}`;
}
