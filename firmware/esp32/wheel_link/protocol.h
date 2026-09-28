// Message validation — the C++ side of protocol/src/codec.ts + messages.ts.
//
// Same rules as decodeClient(): too big / not JSON / not an object / no string `type` /
// no integer `version` / version outside MIN…PROTOCOL_VERSION / unknown type / any
// field missing or out of range → REJECT. Out-of-range values are dropped, never clamped.
// Unknown extra fields are ignored on purpose (forward compatibility).

#pragma once

#include <ArduinoJson.h>
#include <math.h>
#include <string.h>

#include "key_machine.h"

constexpr int PROTOCOL_VERSION = 1;
constexpr int MIN_SUPPORTED_VERSION = 1;
constexpr size_t MAX_MESSAGE_LENGTH = 4096;
constexpr size_t MAX_BUTTONS = 64;
constexpr size_t MAX_ID_LEN = 64;

// Server connection states (controller-state.md §2).
enum class SessionState : uint8_t { Pending, AwaitingFresh, Live, Tripped };

inline const char *stateName(SessionState s) {
  switch (s) {
    case SessionState::AwaitingFresh: return "AWAITING_FRESH";
    case SessionState::Live: return "LIVE";
    case SessionState::Tripped: return "TRIPPED";
    default: return "PENDING";
  }
}

enum class MsgType : uint8_t { Hello, State, OutputConfig, Ping, Bye };

enum class DecodeError : uint8_t { None, TooLarge, Parse, Shape, Version, UnknownType };

inline const char *decodeErrorName(DecodeError e) {
  switch (e) {
    case DecodeError::TooLarge: return "too-large";
    case DecodeError::Parse: return "parse";
    case DecodeError::Shape: return "shape";
    case DecodeError::Version: return "version";
    case DecodeError::UnknownType: return "unknown-type";
    default: return "ok";
  }
}

// ─── value checks (codec.ts "value checks") ───────────────────────────────────

// JSON numbers only (booleans and strings are not numbers), finite.
inline bool jNum(JsonVariantConst v, double &out) {
  if (v.is<bool>() || !v.is<double>()) return false;
  double d = v.as<double>();
  if (!isfinite(d)) return false;
  out = d;
  return true;
}

// Number.isInteger: any finite number with no fractional part (so 3.0 counts).
inline bool jInt(JsonVariantConst v, int64_t &out) {
  if (v.is<bool>()) return false;
  if (v.is<int64_t>()) {
    out = v.as<int64_t>();
    return true;
  }
  double d;
  if (!jNum(v, d) || d != trunc(d) || fabs(d) > 9007199254740991.0) return false;
  out = (int64_t)d;
  return true;
}

inline bool jRange(JsonVariantConst v, double lo, double hi, double &out) {
  return jNum(v, out) && out >= lo && out <= hi;
}

// NOTE: codec.ts counts UTF-16 code units; this counts UTF-8 bytes. Only differs for
// non-ASCII text, where this is stricter.
inline bool jShortStr(JsonVariantConst v, size_t max) {
  if (!v.is<const char *>()) return false;
  return strlen(v.as<const char *>()) <= max;
}

inline bool jIdStr(JsonVariantConst v) {
  if (!v.is<const char *>()) return false;
  size_t n = strlen(v.as<const char *>());
  return n > 0 && n <= MAX_ID_LEN;
}

inline bool jOneOf(JsonVariantConst v, const char *const *allowed, size_t count) {
  if (!v.is<const char *>()) return false;
  const char *s = v.as<const char *>();
  for (size_t i = 0; i < count; i++)
    if (strcmp(s, allowed[i]) == 0) return true;
  return false;
}

/** { name: boolean, ... } with at most MAX_BUTTONS entries. */
inline bool jBoolRecord(JsonVariantConst v) {
  if (!v.is<JsonObjectConst>()) return false;
  size_t count = 0;
  for (JsonPairConst kv : v.as<JsonObjectConst>()) {
    if (!kv.value().is<bool>() || ++count > MAX_BUTTONS) return false;
  }
  return true;
}

inline bool jStrArray(JsonVariantConst v) {
  if (!v.is<JsonArrayConst>()) return false;
  JsonArrayConst a = v.as<JsonArrayConst>();
  if (a.size() > MAX_BUTTONS) return false;
  for (JsonVariantConst e : a)
    if (!jIdStr(e)) return false;
  return true;
}

// ─── decoded messages ─────────────────────────────────────────────────────────

struct StateMsg {
  const char *sessionId;  // points into the JsonDocument — copy before it's cleared
  int64_t seq;
  double timestamp;
  bool armed;
  ControllerInput input;  // steering / throttle / brake / buttons (only the 6 bound actions)
};

struct PingMsg {
  int64_t id;
  double timestamp;
};

struct Decoded {
  DecodeError error = DecodeError::None;
  const char *detail = "";  // which field failed (static string)
  int64_t version = 0;      // set when the error is Version
  MsgType type = MsgType::Bye;
  const char *sessionId = nullptr;  // hello
  StateMsg state{};
  SteerPulseConfig steerPulse{};
  PingMsg ping{};
};

constexpr const char *CONTROL_MODES[] = {"touch-pedals", "gyro-pedals", "hybrid"};
constexpr const char *STEER_MODE_NAMES[] = {"hold", "pwm", "sigma"};

inline Decoded decodeFail(DecodeError e, const char *detail) {
  Decoded d;
  d.error = e;
  d.detail = detail;
  return d;
}

/**
 * decodeClient(). `doc` holds the parsed message afterwards (string pointers in the
 * result point into it).
 */
inline Decoded decodeClient(JsonDocument &doc, const uint8_t *payload, size_t length) {
  if (length > MAX_MESSAGE_LENGTH) return decodeFail(DecodeError::TooLarge, "message too large");
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok)
    return decodeFail(DecodeError::Parse, "not valid JSON");

  // 1. envelope
  if (!doc.is<JsonObjectConst>()) return decodeFail(DecodeError::Shape, "message is not an object");
  JsonObjectConst m = doc.as<JsonObjectConst>();
  if (!m["type"].is<const char *>()) return decodeFail(DecodeError::Shape, "missing \"type\"");
  int64_t version;
  if (!jInt(m["version"], version)) return decodeFail(DecodeError::Shape, "missing \"version\"");
  if (version < MIN_SUPPORTED_VERSION || version > PROTOCOL_VERSION) {
    Decoded d = decodeFail(DecodeError::Version, "unsupported protocol version");
    d.version = version;
    return d;
  }

  // 2. body
  const char *type = m["type"].as<const char *>();
  Decoded d;
  double tmp;

  if (strcmp(type, "hello") == 0) {
    d.type = MsgType::Hello;
    if (!jIdStr(m["sessionId"])) return decodeFail(DecodeError::Shape, "hello: bad or missing \"sessionId\"");
    JsonVariantConst c = m["client"];
    if (!c.is<JsonObjectConst>() || !jShortStr(c["app"], 64) || !jShortStr(c["appVersion"], 64))
      return decodeFail(DecodeError::Shape, "hello: bad or missing \"client\"");
    if (!jOneOf(m["mode"], CONTROL_MODES, 3)) return decodeFail(DecodeError::Shape, "hello: bad or missing \"mode\"");
    if (!jStrArray(m["actionIds"])) return decodeFail(DecodeError::Shape, "hello: bad or missing \"actionIds\"");
    if (!jRange(m["desiredSendRateHz"], 1, 1000, tmp))
      return decodeFail(DecodeError::Shape, "hello: bad or missing \"desiredSendRateHz\"");
    d.sessionId = m["sessionId"].as<const char *>();
    return d;
  }

  if (strcmp(type, "state") == 0) {
    d.type = MsgType::State;
    StateMsg &s = d.state;
    if (!jIdStr(m["sessionId"])) return decodeFail(DecodeError::Shape, "state: bad or missing \"sessionId\"");
    if (!jInt(m["seq"], s.seq) || s.seq < 0) return decodeFail(DecodeError::Shape, "state: bad or missing \"seq\"");
    if (!jNum(m["timestamp"], s.timestamp)) return decodeFail(DecodeError::Shape, "state: bad or missing \"timestamp\"");
    if (!m["armed"].is<bool>()) return decodeFail(DecodeError::Shape, "state: bad or missing \"armed\"");
    if (!jRange(m["steering"], -1, 1, s.input.steering))
      return decodeFail(DecodeError::Shape, "state: bad or missing \"steering\"");
    if (!jRange(m["throttle"], 0, 1, s.input.throttle))
      return decodeFail(DecodeError::Shape, "state: bad or missing \"throttle\"");
    if (!jRange(m["brake"], 0, 1, s.input.brake)) return decodeFail(DecodeError::Shape, "state: bad or missing \"brake\"");
    JsonVariantConst b = m["buttons"];
    if (!jBoolRecord(b)) return decodeFail(DecodeError::Shape, "state: bad or missing \"buttons\"");
    s.sessionId = m["sessionId"].as<const char *>();
    s.armed = m["armed"].as<bool>();
    // keymap.ts: s.buttons[id] === true. Unknown button names are ignored.
    for (uint8_t i = 0; i < ACTION_COUNT; i++) {
      JsonVariantConst v = b[ACTION_IDS[i]];
      s.input.buttons[i] = v.is<bool>() && v.as<bool>();
    }
    return d;
  }

  if (strcmp(type, "output_config") == 0) {
    d.type = MsgType::OutputConfig;
    JsonVariantConst p = m["steerPulse"];
    SteerPulseConfig &c = d.steerPulse;
    if (!p.is<JsonObjectConst>() || !jOneOf(p["mode"], STEER_MODE_NAMES, 3) ||
        !jRange(p["periodMs"], PERIOD_MS_MIN, PERIOD_MS_MAX, c.periodMs) ||
        !jRange(p["minPulseMs"], MIN_PULSE_MS_MIN, MIN_PULSE_MS_MAX, c.minPulseMs) ||
        !jRange(p["fullAt"], FULL_AT_MIN, FULL_AT_MAX, c.fullAt) ||
        // optional (added 2026-09-26): missing → 1, the old behaviour
        (!p["maxDuty"].isNull() && !jRange(p["maxDuty"], MAX_DUTY_MIN, MAX_DUTY_MAX, c.maxDuty)))
      return decodeFail(DecodeError::Shape, "output_config: bad or missing \"steerPulse\"");
    if (p["maxDuty"].isNull()) c.maxDuty = 1;
    const char *mode = p["mode"].as<const char *>();
    c.mode = strcmp(mode, "pwm") == 0 ? SteerMode::Pwm : strcmp(mode, "sigma") == 0 ? SteerMode::Sigma : SteerMode::Hold;
    return d;
  }

  if (strcmp(type, "ping") == 0) {
    d.type = MsgType::Ping;
    if (!jInt(m["id"], d.ping.id) || d.ping.id < 0) return decodeFail(DecodeError::Shape, "ping: bad or missing \"id\"");
    if (!jNum(m["timestamp"], d.ping.timestamp)) return decodeFail(DecodeError::Shape, "ping: bad or missing \"timestamp\"");
    return d;
  }

  if (strcmp(type, "bye") == 0) {
    d.type = MsgType::Bye;
    if (!jShortStr(m["reason"], 256)) return decodeFail(DecodeError::Shape, "bye: bad or missing \"reason\"");
    return d;
  }

  return decodeFail(DecodeError::UnknownType, "unknown message type");
}
