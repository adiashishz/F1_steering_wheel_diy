/**
 * The only place messages are turned into text and back.
 *
 *   encode(msg) → string
 *   decode(raw) → { ok: true, msg } | { ok: false, error }     never throws
 *
 * decode is the gate: bad JSON, wrong version, missing field, or a value out of
 * range is rejected HERE, so nothing downstream ever sees a bad packet.
 * Out-of-range values are rejected, not clamped — clamping would hide a bug.
 *
 * Switching JSON → binary later means changing only this file.
 */

import { isCompatible } from './version';
import { STEER_MODES, STEER_PULSE_LIMITS } from './keymap';
import {
  CONTROL_MODES,
  ERROR_CODES,
  type ClientMessage,
  type ServerMessage,
} from './messages';

/** Anything bigger is rejected before parsing. A state packet is ~200 bytes; an SDP offer ~1–3 KB. */
export const MAX_MESSAGE_LENGTH = 16384;
/** Cap on buttons/actions/keys per message. */
export const MAX_BUTTONS = 64;

export type DecodeErrorCode = 'too-large' | 'parse' | 'shape' | 'version' | 'unknown-type';

export interface DecodeError {
  code: DecodeErrorCode;
  message: string;
}

export type DecodeResult<T> = { ok: true; msg: T } | { ok: false; error: DecodeError };

// ─── encode ─────────────────────────────────────────────────────────────────

export function encodeClient(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

// ─── decode ─────────────────────────────────────────────────────────────────

export function decodeClient(raw: string): DecodeResult<ClientMessage> {
  return decode<ClientMessage>(raw, CLIENT_RULES);
}

export function decodeServer(raw: string): DecodeResult<ServerMessage> {
  return decode<ServerMessage>(raw, SERVER_RULES);
}

// ─── internals ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
/** field name → "is this value OK?" */
type Rules = Record<string, (v: unknown) => boolean>;

function decode<T>(raw: string, rulesByType: Record<string, Rules>): DecodeResult<T> {
  if (raw.length > MAX_MESSAGE_LENGTH) {
    return fail('too-large', `message is ${raw.length} chars, max ${MAX_MESSAGE_LENGTH}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('parse', 'not valid JSON');
  }

  // 1. envelope: must be an object with a string `type` and a compatible `version`
  if (!isObj(parsed)) return fail('shape', 'message is not an object');
  if (!isStr(parsed.type)) return fail('shape', 'missing "type"');
  if (!isInt(parsed.version)) return fail('shape', 'missing "version"');
  if (!isCompatible(parsed.version)) {
    return fail('version', `unsupported protocol version ${parsed.version}`);
  }

  // 2. body: check every field for this message type
  const rules = rulesByType[parsed.type];
  if (!rules) return fail('unknown-type', `unknown message type "${parsed.type}"`);

  for (const field in rules) {
    if (!rules[field]!(parsed[field])) {
      return fail('shape', `${parsed.type}: bad or missing "${field}"`);
    }
  }

  // Unknown extra fields are allowed through on purpose (forward compatibility).
  return { ok: true, msg: parsed as T };
}

function fail(code: DecodeErrorCode, message: string): { ok: false; error: DecodeError } {
  return { ok: false, error: { code, message } };
}

// ─── value checks ───────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const inRange = (lo: number, hi: number) => (v: unknown) => isNum(v) && v >= lo && v <= hi;
const nonNegInt = (v: unknown) => isInt(v) && v >= 0;
const shortStr = (max: number) => (v: unknown) => isStr(v) && v.length <= max;
const idStr = (v: unknown) => isStr(v) && v.length > 0 && v.length <= 64;
const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
const oneOf = (allowed: readonly string[]) => (v: unknown) => isStr(v) && allowed.includes(v);

/** { name: boolean, ... } with at most MAX_BUTTONS entries. */
function boolRecord(v: unknown): boolean {
  if (!isObj(v)) return false;
  let count = 0;
  for (const k in v) {
    if (!isBool(v[k]) || ++count > MAX_BUTTONS) return false;
  }
  return true;
}

function steerPulse(v: unknown): boolean {
  if (!isObj(v)) return false;
  const L = STEER_PULSE_LIMITS;
  return (
    oneOf(STEER_MODES)(v.mode) &&
    inRange(L.periodMs.min, L.periodMs.max)(v.periodMs) &&
    inRange(L.minPulseMs.min, L.minPulseMs.max)(v.minPulseMs) &&
    inRange(L.fullAt.min, L.fullAt.max)(v.fullAt) &&
    optional(inRange(L.maxDuty.min, L.maxDuty.max))(v.maxDuty)
  );
}

function strArray(v: unknown): boolean {
  return Array.isArray(v) && v.length <= MAX_BUTTONS && v.every(idStr);
}

// ─── per-message rules ──────────────────────────────────────────────────────
// `type` and `version` are already checked by the envelope step.

const CLIENT_RULES: Record<ClientMessage['type'], Rules> = {
  hello: {
    sessionId: idStr,
    client: (v) => isObj(v) && shortStr(64)(v.app) && shortStr(64)(v.appVersion),
    mode: oneOf(CONTROL_MODES),
    actionIds: strArray,
    desiredSendRateHz: inRange(1, 1000),
  },
  state: {
    sessionId: idStr,
    seq: nonNegInt,
    timestamp: isNum,
    armed: isBool,
    steering: inRange(-1, 1),
    throttle: inRange(0, 1),
    brake: inRange(0, 1),
    buttons: boolRecord,
  },
  output_config: {
    steerPulse,
  },
  rtc_offer: {
    sdp: shortStr(12000),
  },
  log: {
    text: shortStr(500),
  },
  ping: {
    id: nonNegInt,
    timestamp: isNum,
  },
  bye: {
    reason: shortStr(256),
  },
};

const SERVER_RULES: Record<ServerMessage['type'], Rules> = {
  hello_ack: {
    accepted: isBool,
    reason: optional(shortStr(256)),
    server: (v) => isObj(v) && shortStr(64)(v.name) && shortStr(64)(v.version),
    watchdogMs: inRange(1, 10_000),
    maxSendRateHz: inRange(1, 1000),
    serverTime: isNum,
  },
  rtc_answer: {
    sdp: shortStr(12000),
  },
  pong: {
    id: nonNegInt,
    clientTimestamp: isNum,
    serverTimestamp: isNum,
  },
  status: {
    lastSeq: isInt,
    packetsPerSec: isNum,
    droppedPackets: nonNegInt,
    outputArmed: isBool,
    watchdogTripped: isBool,
    keys: boolRecord,
    steerDuty: optional(inRange(0, 1)),
    steerPressesPerSec: optional((v) => isNum(v) && v >= 0),
    linkRttMs: optional((v) => isNum(v) && v >= 0),
  },
  error: {
    code: oneOf(ERROR_CODES),
    message: shortStr(512),
    fatal: isBool,
  },
};
