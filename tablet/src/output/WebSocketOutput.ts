/**
 * WebSocketOutput — ControllerState → the ESP32 (or the mock server) over a WebSocket.
 *
 *   connect ─► hello ─► hello_ack ─► LIVE ─► output_config, then state ×100/s, ping ×2/s
 *                                    ◄── status ×5/s (what the ESP32 is really pressing)
 *   close / silence > 1.5 s ─► not ready (the loop disarms) ─► reconnect with backoff
 *
 * The ESP32 owns the real safety (its watchdog releases keys after 150 ms of
 * silence). This side only makes sure the tablet SHOWS the truth: not ready
 * unless the link is live, so the loop can't stay armed against a dead link.
 *
 * Default URL is `/esp` on the page's own host: Vite proxies it to the ESP32,
 * which keeps the page and socket same-origin (no mixed-content block on https).
 * Override with `?esp=ws://192.168.1.50:8080`.
 */

import {
  DEFAULT_STEER_PULSE,
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type ClientMessage,
  type ControllerState,
  type StateMessage,
  type StatusMessage,
  type SteerPulseConfig,
} from '@wheel/protocol';
import { createOutputStats, type OutputDevice } from './OutputDevice';

export type LinkState = 'idle' | 'connecting' | 'handshake' | 'live' | 'closed' | 'rejected';

/** Everything the UI shows about the link. Mutated in place; read it a few times a second. */
export interface LinkInfo {
  state: LinkState;
  url: string;
  /** Last ping round trip, ms. NaN until the first pong. */
  rttMs: number;
  server: string;
  lastError: string;
  /** Latest status from the ESP32, or null. */
  status: StatusMessage | null;
  /** performance.now() of the last message from the server. */
  lastHeardAt: number;
  reconnects: number;
  /** Drops of a LIVE link, and why the last one happened. */
  drops: number;
  lastDrop: string;
}

const PING_MS = 500;
/** Nothing at all from the server for this long (status comes 5×/s) → assume the link is dead. */
const SILENCE_MS = 1500;
/** Socket send buffer above this → drop state packets rather than queue stale ones. */
const MAX_BUFFERED = 8 * 1024;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 4000;

export class WebSocketOutput implements OutputDevice {
  readonly id = 'esp32';
  readonly label = 'ESP32 (WebSocket)';
  readonly stats = createOutputStats();
  readonly link: LinkInfo = {
    state: 'idle',
    url: '',
    rttMs: NaN,
    server: '',
    lastError: '',
    status: null,
    lastHeardAt: 0,
    reconnects: 0,
    drops: 0,
    lastDrop: '',
  };

  private ws: WebSocket | null = null;
  private seq = 0;
  private pingId = 0;
  private backoff = BACKOFF_MIN_MS;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private steerPulse: SteerPulseConfig = DEFAULT_STEER_PULSE;
  private actionIds: readonly string[] = [];

  /** The one state message, refilled every tick. */
  private readonly msg: StateMessage = {
    type: 'state',
    version: PROTOCOL_VERSION,
    sessionId: '',
    seq: 0,
    timestamp: 0,
    armed: false,
    steering: 0,
    throttle: 0,
    brake: 0,
    buttons: {},
  };

  constructor(url: string = defaultEspUrl(), actionIds: readonly string[] = []) {
    this.link.url = url;
    this.actionIds = actionIds;
  }

  get ready(): boolean {
    return this.link.state === 'live';
  }

  /** Start connecting (and keep reconnecting) until dispose(). */
  connect(): void {
    if (!this.stopped && this.ws) return;
    this.stopped = false;
    this.backoff = BACKOFF_MIN_MS;
    this.open();
  }

  /**
   * Hang up without giving up: the page is hidden, so let another page (or the
   * same one, later) have the ESP32 — it only serves one driver at a time.
   * connect() picks up again.
   */
  pause(): void {
    this.releaseAll(performance.now(), 'hidden');
    this.stopped = true;
    this.close('page hidden');
    this.link.state = 'idle';
  }

  /** Point at a different server and reconnect. */
  setUrl(url: string): void {
    this.link.url = url;
    this.link.reconnects = 0;
    this.backoff = BACKOFF_MIN_MS;
    this.close('url changed');
    if (!this.stopped) this.open();
  }

  send(state: Readonly<ControllerState>, now: number, armed: boolean): void {
    const ws = this.ws;
    if (!this.ready || !ws || ws.bufferedAmount > MAX_BUFFERED) {
      this.stats.dropped++;
      return;
    }
    const m = this.msg;
    m.seq = this.seq++;
    m.timestamp = now;
    m.armed = armed;
    m.steering = clampSigned(state.steering);
    m.throttle = clampUnit(state.throttle);
    m.brake = clampUnit(state.brake);
    m.buttons = state.buttons; // serialised right below, never kept
    ws.send(encodeClient(m));
    this.stats.sent++;
    this.stats.lastSentAt = now;
  }

  /** Send one neutral, disarmed packet right away instead of waiting for the next tick. */
  releaseAll(now: number, _reason: string): void {
    this.stats.releases++;
    if (!this.ready || !this.ws) return;
    const m = this.msg;
    m.seq = this.seq++;
    m.timestamp = now;
    m.armed = false;
    m.steering = 0;
    m.throttle = 0;
    m.brake = 0;
    m.buttons = {};
    this.ws.send(encodeClient(m));
  }

  configure(opts: { steerPulse: SteerPulseConfig }): void {
    this.steerPulse = opts.steerPulse;
    if (this.ready) this.sendOutputConfig();
  }

  dispose(): void {
    this.releaseAll(performance.now(), 'dispose');
    this.stopped = true;
    this.close('dispose');
    this.link.state = 'idle';
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private open(): void {
    clearTimeout(this.retry);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.link.url);
    } catch (e) {
      this.link.lastError = e instanceof Error ? e.message : String(e);
      this.link.state = 'rejected'; // bad URL — retrying won't help
      return;
    }
    this.ws = ws;
    this.link.state = 'connecting';

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.link.state = 'handshake';
      this.link.lastHeardAt = performance.now();
      this.msg.sessionId = newSessionId();
      this.seq = 0;
      this.post({
        type: 'hello',
        version: PROTOCOL_VERSION,
        sessionId: this.msg.sessionId,
        client: { app: 'wheeldiy-tablet', appVersion: '0.1.0' },
        mode: 'touch-pedals',
        actionIds: [...this.actionIds],
        desiredSendRateHz: 100,
      });
      this.timer = setInterval(this.onTimer, PING_MS);
    };

    ws.onmessage = (e) => {
      if (ws !== this.ws || typeof e.data !== 'string') return;
      this.link.lastHeardAt = performance.now();
      const r = decodeServer(e.data);
      if (!r.ok) {
        this.link.lastError = r.error.message;
        return;
      }
      const msg = r.msg;
      switch (msg.type) {
        case 'hello_ack':
          if (!msg.accepted) {
            this.link.lastError = msg.reason ?? 'rejected';
            this.link.state = 'rejected';
            this.close('rejected');
            return;
          }
          this.link.server = `${msg.server.name} ${msg.server.version}`;
          this.link.state = 'live';
          this.link.lastError = '';
          this.backoff = BACKOFF_MIN_MS;
          this.sendOutputConfig();
          break;
        case 'pong':
          this.link.rttMs = performance.now() - msg.clientTimestamp;
          break;
        case 'status':
          this.link.status = msg;
          if (msg.watchdogTripped && this.ready) {
            // The ESP32 stays neutral until a NEW session. Reconnect (the loop disarms
            // meanwhile), so the tablet never shows "armed" against a board that ignores it.
            this.link.lastError = 'ESP32 watchdog tripped — reconnecting';
            this.noteDrop('ESP32 watchdog: packets late > 300 ms (Wi-Fi stall)');
            this.close('watchdog tripped');
            this.scheduleReconnect();
          }
          break;
        case 'error':
          this.link.lastError = `${msg.code}: ${msg.message}`;
          if (msg.fatal) {
            this.link.state = 'rejected';
            this.close('fatal error');
          }
          break;
      }
    };

    ws.onerror = () => {
      if (ws === this.ws) this.link.lastError = 'socket error';
    };

    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      this.ws = null;
      clearInterval(this.timer);
      this.link.status = null;
      if (this.link.state === 'live') this.noteDrop(`socket closed by ESP32 / network (code ${e.code})`);
      if (this.link.state !== 'rejected') this.link.state = 'closed';
      this.scheduleReconnect();
    };
  }

  private readonly onTimer = (): void => {
    const now = performance.now();
    if (now - this.link.lastHeardAt > SILENCE_MS) {
      // Don't wait for onclose: on a dead network the browser can take many seconds to fire it.
      if (this.ready) this.noteDrop('no reply for 1.5 s (Wi-Fi)');
      this.close('silence');
      this.link.lastError = 'no reply from ESP32';
      this.scheduleReconnect();
      return;
    }
    if (this.ready) this.post({ type: 'ping', version: PROTOCOL_VERSION, id: this.pingId++, timestamp: now });
  };

  private noteDrop(reason: string): void {
    this.link.drops++;
    this.link.lastDrop = `${new Date().toLocaleTimeString()} ${reason}`;
    console.warn(`[esp] link drop #${this.link.drops}: ${reason}`);
  }

  private sendOutputConfig(): void {
    this.post({ type: 'output_config', version: PROTOCOL_VERSION, steerPulse: this.steerPulse });
  }

  private post(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(msg));
  }

  private close(reason: string): void {
    clearInterval(this.timer);
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeClient({ type: 'bye', version: PROTOCOL_VERSION, reason }));
      ws.close();
    }
    if (this.link.state !== 'rejected') this.link.state = 'closed';
    this.link.status = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.link.state === 'rejected') return;
    this.retry = setTimeout(() => {
      this.link.reconnects++;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }
}

/** `?esp=` wins; otherwise `/esp` on this page's host (proxied by Vite to the ESP32). */
export function defaultEspUrl(): string {
  const param = new URLSearchParams(location.search).get('esp');
  if (param) return param;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/esp`;
}

/** crypto.randomUUID only exists in secure contexts; plain http on the LAN doesn't have it. */
function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The ESP32 rejects out-of-range values, so never send a float that drifted a hair past ±1.
const clampSigned = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
const clampUnit = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
