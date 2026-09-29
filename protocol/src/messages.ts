/**
 * Every message that crosses the wire between tablet and ESP32.
 *
 * Each message has a `type` (what kind it is) and a `version` (which protocol
 * it speaks). The receiver switches on `type` and rejects bad versions.
 *
 * Forward compatibility (plan.md §17): receivers IGNORE fields they don't know.
 * So a newer tablet can add a field without breaking older firmware.
 *
 *   tablet ──hello──►  ESP32         "I'm connecting, here's who I am"
 *   tablet ◄─hello_ack─ ESP32        "accepted, here are my limits"
 *   tablet ──state──►  ESP32         100×/sec: what the driver is doing
 *   tablet ──output_config──► ESP32  on connect + on change: how to turn steering into keys
 *   tablet ──rtc_offer──► / ◄──rtc_answer──  optional: open a WebRTC data channel
 *                                    (unordered, no retransmits) and move state + ping onto it
 *   tablet ──ping───►  ESP32   ──┐
 *   tablet ◄─pong──── ESP32   ◄─┘   round trip = latency
 *   tablet ◄─status── ESP32          ~5×/sec: what the ESP32 is actually pressing
 *   tablet ◄─error─── ESP32          something was rejected
 *   tablet ──bye────►  ESP32         clean disconnect
 */

import type { ActionId } from './controllerState';
import type { SteerPulseConfig } from './keymap';

/** The three ways inputs can be mapped (plan.md §11). */
export type ControlMode = 'touch-pedals' | 'gyro-pedals' | 'hybrid';
export const CONTROL_MODES: readonly ControlMode[] = ['touch-pedals', 'gyro-pedals', 'hybrid'];

// ─── tablet → ESP32 ─────────────────────────────────────────────────────────

export interface HelloMessage {
  type: 'hello';
  version: number;
  /** New random id for every connection. Packets with another id are stale and rejected. */
  sessionId: string;
  client: { app: string; appVersion: string };
  mode: ControlMode;
  /** Every action the tablet will report in `buttons`. */
  actionIds: ActionId[];
  desiredSendRateHz: number;
}

export interface StateMessage {
  type: 'state';
  version: number;
  sessionId: string;
  /** Counts up from 0 on each connection. Lets the receiver spot gaps and old packets. */
  seq: number;
  /** Tablet clock (ms) when this was produced. */
  timestamp: number;
  /** false → the ESP32 must treat this packet as "everything released". */
  armed: boolean;
  steering: number; // -1..1
  throttle: number; //  0..1
  brake: number; //  0..1
  buttons: Record<ActionId, boolean>;
}

/**
 * Output tuning the tablet pushes to the ESP32. Sent right after hello_ack and
 * again whenever a setting changes. Changing it never releases keys by itself.
 */
export interface OutputConfigMessage {
  type: 'output_config';
  version: number;
  steerPulse: SteerPulseConfig;
}

/**
 * WebRTC set-up, carried over the WebSocket. Full SDP, candidates included (no
 * trickle) — on a LAN only host candidates exist and gathering is instant.
 * Once the data channel is open, `state` and `ping` go over it; a late or lost
 * packet is just skipped (seq already rejects old ones) instead of stalling
 * everything behind it the way TCP does. Everything else stays on the socket.
 */
export interface RtcOfferMessage {
  type: 'rtc_offer';
  version: number;
  sdp: string;
}

export interface RtcAnswerMessage {
  type: 'rtc_answer';
  version: number;
  sdp: string;
}

/** Diagnostics only: a line for the bridge's log (e.g. every pedal touch). Never affects output. */
export interface LogMessage {
  type: 'log';
  version: number;
  text: string;
}

export interface PingMessage {
  type: 'ping';
  version: number;
  id: number;
  timestamp: number;
}

export interface ByeMessage {
  type: 'bye';
  version: number;
  reason: string;
}

export type ClientMessage =
  | HelloMessage
  | StateMessage
  | OutputConfigMessage
  | RtcOfferMessage
  | LogMessage
  | PingMessage
  | ByeMessage;

// ─── ESP32 → tablet ─────────────────────────────────────────────────────────

export interface HelloAckMessage {
  type: 'hello_ack';
  version: number;
  accepted: boolean;
  reason?: string;
  server: { name: string; version: string };
  /** No valid state for this long → ESP32 releases every key. The tablet sizes its send rate from this. */
  watchdogMs: number;
  maxSendRateHz: number;
  serverTime: number;
}

export interface PongMessage {
  type: 'pong';
  version: number;
  id: number;
  /** Echo of the ping's timestamp, so latency = now − clientTimestamp. */
  clientTimestamp: number;
  serverTimestamp: number;
}

export interface StatusMessage {
  type: 'status';
  version: number;
  lastSeq: number;
  packetsPerSec: number;
  droppedPackets: number;
  outputArmed: boolean;
  watchdogTripped: boolean;
  /** Ground truth: which keys the ESP32 is holding right now, e.g. { KeyA: true }. */
  keys: Record<string, boolean>;
  /** Optional: duty the steer key is pulsing at, 0 … 1 ('hold' reports 0 or 1). */
  steerDuty?: number;
  /** Optional: steer key presses in the last second — shows the pulses actually happening. */
  steerPressesPerSec?: number;
  /** Optional: round trip of the NEXT hop (e.g. Mac ↔ PS5 for the ps5-link bridge), ms. */
  linkRttMs?: number;
}

export type ErrorCode = 'version' | 'handshake' | 'malformed' | 'stale' | 'rate';
export const ERROR_CODES: readonly ErrorCode[] = ['version', 'handshake', 'malformed', 'stale', 'rate'];

export interface ErrorMessage {
  type: 'error';
  version: number;
  code: ErrorCode;
  message: string;
  /** true → the server will close the connection; don't auto-reconnect into the same error. */
  fatal: boolean;
}

export type ServerMessage = HelloAckMessage | RtcAnswerMessage | PongMessage | StatusMessage | ErrorMessage;
