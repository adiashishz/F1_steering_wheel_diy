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
 * Transport: once LIVE, a WebRTC data channel is opened next to the socket —
 * unordered, ZERO retransmits (UDP-like). State + ping go over it, so a packet
 * lost to a Wi-Fi hiccup is skipped instead of freezing everything behind it
 * (what TCP does). The socket stays for set-up, status, config, and as the
 * fallback whenever the channel isn't open. `link.transport` says which is used.
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

/** The page came through `adb reverse` over a USB cable (see README: "Tablet over USB"). */
const OVER_USB = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/** 'busy' = another device is driving; we retry quietly and take over once it stops. */
export type LinkState = 'idle' | 'connecting' | 'handshake' | 'live' | 'closed' | 'rejected' | 'busy';

/** Everything the UI shows about the link. Mutated in place; read it a few times a second. */
export interface LinkInfo {
  state: LinkState;
  url: string;
  /** Last ping round trip, ms. NaN until the first pong. */
  rttMs: number;
  server: string;
  /** What's actually on the other end, from hello_ack's server name. See outputKind(). */
  kind: OutputKind;
  lastError: string;
  /** Latest status from the ESP32, or null. */
  status: StatusMessage | null;
  /** performance.now() of the last message from the server. */
  lastHeardAt: number;
  reconnects: number;
  /** What carries state + ping right now: 'rtc' (UDP-like data channel) or 'ws' (TCP). */
  transport: 'ws' | 'rtc' | 'usb';
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
const BUSY_RETRY_MS = 3000;
/** Data channel send buffer above this → drop the packet (a newer one follows in 10 ms). */
const MAX_DC_BUFFERED = 16 * 1024;
/** Give up waiting for ICE gathering after this and send what we have. */
const ICE_GATHER_MAX_MS = 1500;

export class WebSocketOutput implements OutputDevice {
  readonly id = 'link';
  readonly label = 'Link (WebSocket)';
  readonly stats = createOutputStats();
  readonly link: LinkInfo = {
    state: 'idle',
    url: '',
    rttMs: NaN,
    server: '',
    kind: 'unknown',
    lastError: '',
    status: null,
    lastHeardAt: 0,
    reconnects: 0,
    transport: OVER_USB ? 'usb' : 'ws',
    drops: 0,
    lastDrop: '',
  };

  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
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
    const dc = this.dc?.readyState === 'open' ? this.dc : null;
    if (!this.ready || !ws || (dc ? dc.bufferedAmount > MAX_DC_BUFFERED : ws.bufferedAmount > MAX_BUFFERED)) {
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
    (dc ?? ws).send(encodeClient(m));
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

  /** Diagnostics line for the bridge's log (reliable socket; never affects output). */
  debug(text: string): void {
    this.post({ type: 'log', version: PROTOCOL_VERSION, text: text.slice(0, 500) });
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
          if (!msg.accepted && msg.reason?.startsWith('busy')) {
            this.close('busy');
            this.link.state = 'busy';
            this.link.lastError = 'another device is driving — waiting';
            this.retry = setTimeout(() => this.open(), BUSY_RETRY_MS);
            return;
          }
          if (!msg.accepted) {
            this.link.lastError = msg.reason ?? 'rejected';
            this.link.state = 'rejected';
            this.close('rejected');
            return;
          }
          this.link.server = `${msg.server.name} ${msg.server.version}`;
          this.link.kind = outputKind(msg.server.name);
          this.link.state = 'live';
          this.link.lastError = '';
          this.backoff = BACKOFF_MIN_MS;
          this.sendOutputConfig();
          // Opened as localhost = the USB tunnel (adb reverse): TCP only, no loss, so stay on the WebSocket.
          if (!OVER_USB) void this.startRtc();
          break;
        case 'rtc_answer':
          this.pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch((e) => {
            this.link.lastError = `rtc answer rejected: ${e instanceof Error ? e.message : e}`;
          });
          break;
        case 'pong':
          this.link.rttMs = performance.now() - msg.clientTimestamp;
          break;
        case 'status': {
          const wasTripped = this.link.status?.watchdogTripped === true;
          this.link.status = msg;
          // The bridge released everything and resumes on its own as soon as our
          // fresh packets arrive again — no reconnect. Just record it.
          if (msg.watchdogTripped && !wasTripped) this.noteDrop('watchdog released all: packets late > 300 ms (Wi-Fi)');
          break;
        }
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
      this.closeRtc();
      this.link.status = null;
      if (this.link.state === 'live') this.noteDrop(`socket closed by the bridge / network (code ${e.code})`);
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
      this.link.lastError = 'no reply from the bridge';
      this.scheduleReconnect();
      return;
    }
    if (!this.ready) return;
    const ping = encodeClient({ type: 'ping', version: PROTOCOL_VERSION, id: this.pingId++, timestamp: now });
    // Over the channel when it's up, so the RTT shown is the path state actually takes.
    if (this.dc?.readyState === 'open') this.dc.send(ping);
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(ping);
  };

  private noteDrop(reason: string): void {
    this.link.drops++;
    this.link.lastDrop = `${new Date().toLocaleTimeString()} ${reason}`;
    console.warn(`[esp] link drop #${this.link.drops}: ${reason}`);
  }

  /**
   * Open the UDP-like side channel. Full SDP, no trickle: on a LAN only host
   * candidates exist, so gathering finishes almost at once. Any failure just
   * leaves us on the WebSocket.
   */
  private async startRtc(): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return;
    this.closeRtc();
    const ws = this.ws;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      const dc = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
      dc.onopen = () => {
        if (this.pc !== pc) return;
        this.dc = dc;
        this.link.transport = 'rtc';
      };
      dc.onclose = () => {
        if (this.dc === dc) {
          this.dc = null;
          this.link.transport = OVER_USB ? 'usb' : 'ws';
        }
      };
      dc.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        this.link.lastHeardAt = performance.now();
        const r = decodeServer(e.data);
        if (r.ok && r.msg.type === 'pong') this.link.rttMs = performance.now() - r.msg.clientTimestamp;
      };
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, ICE_GATHER_MAX_MS);
      if (this.pc !== pc || this.ws !== ws || !pc.localDescription) return;
      this.post({ type: 'rtc_offer', version: PROTOCOL_VERSION, sdp: pc.localDescription.sdp });
    } catch (e) {
      this.link.lastError = `rtc unavailable: ${e instanceof Error ? e.message : e}`;
      this.closeRtc();
    }
  }

  private closeRtc(): void {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.link.transport = OVER_USB ? 'usb' : 'ws';
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
    this.closeRtc();
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

/**
 * Which output is on the other end of the socket. Same tablet, same messages —
 * only the label (and what the status line means) differs.
 */
export type OutputKind = 'ps5-direct' | 'dualsense' | 'keyboard' | 'mock' | 'unknown';

export function outputKind(serverName: string): OutputKind {
  switch (serverName) {
    case 'mac-ps5-link':
      return 'ps5-direct'; //  Mac → ps5-link (libchiaki) → PS5, no video
    case 'mac-pad-bridge':
      return 'dualsense'; //   Mac → ESP32 as a USB DualSense → PS Remote Play
    case 'esp32-s3':
      return 'keyboard'; //    ESP32 wheel_link → USB keyboard → PS5
    case 'mock-esp32':
      return 'mock';
    default:
      return 'unknown';
  }
}

export const OUTPUT_LABEL: Record<OutputKind, string> = {
  'ps5-direct': 'PS5 direct',
  dualsense: 'DualSense (ESP32)',
  keyboard: 'ESP32 keyboard',
  mock: 'Mock',
  unknown: 'Link',
};

/** `?esp=` wins; otherwise `/esp` on this page's host (proxied by Vite to the ESP32). */
export function defaultEspUrl(): string {
  const param = new URLSearchParams(location.search).get('esp');
  if (param) return param;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/esp`;
}

/** Resolve when ICE gathering is complete, or after `maxMs` regardless. */
function gathered(pc: RTCPeerConnection, maxMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, maxMs);
  });
}

/** crypto.randomUUID only exists in secure contexts; plain http on the LAN doesn't have it. */
function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The ESP32 rejects out-of-range values, so never send a float that drifted a hair past ±1.
const clampSigned = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);
const clampUnit = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
