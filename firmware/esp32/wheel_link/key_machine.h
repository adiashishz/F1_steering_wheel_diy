// C++ port of protocol/src/keymap.ts (KeyStateMachine) and protocol/src/pedals.ts
// (enforceExclusivity, policy 'dominant'). Same numbers, same order of operations.
// If this file and the .ts files disagree, the .ts files win — fix this one.
//
//   update(input) → which keys SHOULD be down     (hysteresis 0.15 on / 0.10 off)
//   tick(now)     → real press/release events      (min hold 30 ms, min gap 20 ms)
//                   RELEASES BEFORE PRESSES within one tick, so steering right→left
//                   never holds both keys at once.
//   releaseAll()  → everything up now, ignoring min hold. Stopping always wins.
//
// Pulse steering ('pwm' / 'sigma'): the steer keys skip min hold / min gap and follow
// runPulser() instead. Needs tick() about every 1 ms; `now` is a double ms clock so
// sub-millisecond time isn't lost.
//
// The key set is fixed (F1 25 PS5 "Keyboard Preset 1"), so there's no setConfig().

#pragma once

#include <math.h>
#include <stdint.h>

// ─── keys ─────────────────────────────────────────────────────────────────────

// Order = insertion order of the Map in keymap.ts buildKeys():
// steerLeft, steerRight, throttle, brake, then actionKeys in declaration order.
enum KeyIndex : uint8_t {
  K_STEER_LEFT,
  K_STEER_RIGHT,
  K_THROTTLE,
  K_BRAKE,
  K_GEAR_UP,
  K_GEAR_DOWN,
  K_DRS,
  K_ERS,
  K_MFD,
  K_RADIO,
  KEY_COUNT
};

struct KeyDef {
  const char *name;  // protocol name (browser KeyboardEvent.code), used in `status.keys`
  uint8_t hid;       // USB HID usage ID, keyboard page 0x07
};

// USB HID usage IDs, matching F1 25 on PS5 "Keyboard Preset 1" (confirmed F.3).
constexpr KeyDef KEYS[KEY_COUNT] = {
    {"Comma", 0x36},      // ,          Steer Left
    {"Period", 0x37},     // .          Steer Right
    {"KeyA", 0x04},       // A          Accelerate
    {"KeyZ", 0x1D},       // Z          Brake / Reverse
    {"Space", 0x2C},      // Space      Gear Up
    {"ShiftLeft", 0xE1},  // Left Shift Gear Down  (modifier: pressRaw sets bit 1 of the modifier byte)
    {"KeyF", 0x09},       // F          DRS
    {"KeyM", 0x10},       // M          Overtake / Boost (ers)
    {"Numpad0", 0x62},    // Keypad 0   MFD
    {"KeyT", 0x17},       // T          Radio
};

// ─── actions (state.buttons) ──────────────────────────────────────────────────

enum ActionIndex : uint8_t { A_GEAR_UP, A_GEAR_DOWN, A_DRS, A_ERS, A_MFD, A_RADIO, ACTION_COUNT };
constexpr const char *ACTION_IDS[ACTION_COUNT] = {"gearUp", "gearDown", "drs", "ers", "mfd", "radio"};
constexpr uint8_t ACTION_KEY[ACTION_COUNT] = {K_GEAR_UP, K_GEAR_DOWN, K_DRS, K_ERS, K_MFD, K_RADIO};

// ─── thresholds (DEFAULT_KEYMAP) ──────────────────────────────────────────────

constexpr double STEER_ON = 0.15;
constexpr double STEER_OFF = 0.10;
constexpr double PEDAL_ON = 0.15;
constexpr double PEDAL_OFF = 0.10;
constexpr double MIN_HOLD_MS = 30;
constexpr double MIN_GAP_MS = 20;

// ─── steer pulse (STEER_PULSE_LIMITS / DEFAULT_STEER_PULSE) ───────────────────

enum class SteerMode : uint8_t { Hold, Pwm, Sigma };

inline const char *steerModeName(SteerMode m) {
  switch (m) {
    case SteerMode::Pwm: return "pwm";
    case SteerMode::Sigma: return "sigma";
    default: return "hold";
  }
}

struct SteerPulseConfig {
  SteerMode mode;
  double periodMs;    // pwm: one on + off cycle
  double minPulseMs;  // pwm + sigma: shortest press AND shortest gap
  double fullAt;      // |steering| ≥ this → full duty; below, duty = |steering| / fullAt
  double maxDuty;     // duty at full steering. 1 → hold solid there; lower → still pulses
};

constexpr double PERIOD_MS_MIN = 10, PERIOD_MS_MAX = 500;
constexpr double MIN_PULSE_MS_MIN = 4, MIN_PULSE_MS_MAX = 100;  // 4 ms ≥ 4 USB polls
constexpr double FULL_AT_MIN = 0.3, FULL_AT_MAX = 1;
constexpr double MAX_DUTY_MIN = 0.05, MAX_DUTY_MAX = 1;

constexpr SteerPulseConfig DEFAULT_STEER_PULSE = {SteerMode::Hold, 40, 10, 0.95, 1};

/** Clamp into the limits (wire values are range-checked before this; it's a second guard). */
inline SteerPulseConfig sanitizeSteerPulse(const SteerPulseConfig &p) {
  auto fit = [](double v, double lo, double hi, double fallback) {
    return isfinite(v) ? fmin(fmax(v, lo), hi) : fallback;
  };
  SteerPulseConfig out;
  out.mode = (p.mode == SteerMode::Pwm || p.mode == SteerMode::Sigma) ? p.mode : SteerMode::Hold;
  out.periodMs = fit(p.periodMs, PERIOD_MS_MIN, PERIOD_MS_MAX, DEFAULT_STEER_PULSE.periodMs);
  out.minPulseMs = fit(p.minPulseMs, MIN_PULSE_MS_MIN, MIN_PULSE_MS_MAX, DEFAULT_STEER_PULSE.minPulseMs);
  out.fullAt = fit(p.fullAt, FULL_AT_MIN, FULL_AT_MAX, DEFAULT_STEER_PULSE.fullAt);
  out.maxDuty = fit(p.maxDuty, MAX_DUTY_MIN, MAX_DUTY_MAX, DEFAULT_STEER_PULSE.maxDuty);
  return out;
}

// ─── input ────────────────────────────────────────────────────────────────────

struct ControllerInput {
  double steering;  // -1 … +1
  double throttle;  //  0 … 1
  double brake;     //  0 … 1
  bool buttons[ACTION_COUNT];
};

constexpr ControllerInput NEUTRAL_INPUT = {0, 0, 0, {false, false, false, false, false, false}};

/**
 * pedals.ts enforceExclusivity(s, 'dominant', 0.05). Changes `s` in place.
 * Both pedals above threshold → zero the smaller one; a tie goes to brake.
 * Returns true if it had to zero something.
 */
constexpr double EXCLUSIVITY_THRESHOLD = 0.05;
inline bool enforceExclusivityDominant(ControllerInput &s, double threshold = EXCLUSIVITY_THRESHOLD) {
  if (s.throttle <= threshold || s.brake <= threshold) return false;
  if (s.throttle > s.brake) s.brake = 0;
  else s.throttle = 0;
  return true;
}

// ─── the machine ──────────────────────────────────────────────────────────────

struct KeyEvent {
  uint8_t key;  // KeyIndex
  bool down;
};

class KeyStateMachine {
 public:
  /** Change only the steering pulse settings. Does NOT release keys. */
  void setSteerPulse(const SteerPulseConfig &p) {
    pulse_ = sanitizeSteerPulse(p);
    resetPulse();
  }
  const SteerPulseConfig &steerPulse() const { return pulse_; }

  /** Duty the steering keys are running at: 0 … 1. 'hold' reports 0 or 1. */
  double steerDuty() const { return duty_; }

  bool isDown(uint8_t key) const { return keys_[key].down; }

  /** Work out which keys SHOULD be down. Produces no events on its own — call tick(). */
  void update(const ControllerInput &s) {
    // NaN compares false everywhere → released, the safe default.
    leftOn_ = leftOn_ ? s.steering < -STEER_OFF : s.steering < -STEER_ON;
    rightOn_ = rightOn_ ? s.steering > STEER_OFF : s.steering > STEER_ON;
    throttleOn_ = throttleOn_ ? s.throttle > PEDAL_OFF : s.throttle > PEDAL_ON;
    brakeOn_ = brakeOn_ ? s.brake > PEDAL_OFF : s.brake > PEDAL_ON;

    steerDir_ = leftOn_ ? -1 : rightOn_ ? 1 : 0;
    steerMag_ = steerDir_ == 0 ? 0 : fmin(fabs(s.steering), 1.0);

    for (auto &k : keys_) k.want = false;

    if (pulse_.mode == SteerMode::Hold) {
      want(K_STEER_LEFT, leftOn_);
      want(K_STEER_RIGHT, rightOn_);
      duty_ = steerDir_ == 0 ? 0 : 1;
    }
    // Pulse modes: tick() sets the steer keys, because pulses change between packets.
    want(K_THROTTLE, throttleOn_);
    want(K_BRAKE, brakeOn_);
    for (uint8_t i = 0; i < ACTION_COUNT; i++) want(ACTION_KEY[i], s.buttons[i]);
  }

  /**
   * Turn wants into real press/release events, respecting min hold / min gap.
   * Writes up to KEY_COUNT events into `out` (each key changes at most once per tick),
   * releases first. Returns the number written.
   */
  uint8_t tick(double now, KeyEvent *out) {
    uint8_t n = 0;
    const bool pulsing = pulse_.mode != SteerMode::Hold;
    if (pulsing) {
      const bool on = runPulser(now);
      keys_[K_STEER_LEFT].want = on && steerDir_ < 0;
      keys_[K_STEER_RIGHT].want = on && steerDir_ > 0;
    }

    // Pass 1: releases.
    for (uint8_t i = 0; i < KEY_COUNT; i++) {
      Key &k = keys_[i];
      if (!k.down || k.want) continue;
      const bool exempt = pulsing && (i == K_STEER_LEFT || i == K_STEER_RIGHT);
      if (!exempt && now - k.changedAt < MIN_HOLD_MS) continue;  // held too briefly — release later
      k.down = false;
      k.changedAt = now;
      out[n++] = {i, false};
    }
    // Pass 2: presses.
    for (uint8_t i = 0; i < KEY_COUNT; i++) {
      Key &k = keys_[i];
      if (k.down || !k.want) continue;
      const bool exempt = pulsing && (i == K_STEER_LEFT || i == K_STEER_RIGHT);
      if (!exempt && now - k.changedAt < MIN_GAP_MS) continue;  // released too recently — press later
      k.down = true;
      k.changedAt = now;
      out[n++] = {i, true};
    }
    return n;
  }

  /** Release every key RIGHT NOW, ignoring min hold. Safe to call repeatedly. */
  uint8_t releaseAll(double now, KeyEvent *out) {
    uint8_t n = 0;
    leftOn_ = rightOn_ = throttleOn_ = brakeOn_ = false;
    steerDir_ = 0;
    steerMag_ = 0;
    resetPulse();
    for (uint8_t i = 0; i < KEY_COUNT; i++) {
      Key &k = keys_[i];
      k.want = false;
      if (!k.down) continue;
      k.down = false;
      k.changedAt = now;
      out[n++] = {i, false};
    }
    return n;
  }

 private:
  struct Key {
    bool down = false;              // what we're telling the host right now
    bool want = false;              // what the latest state asks for
    double changedAt = -INFINITY;   // when `down` last changed; -inf → may change immediately
  };

  Key keys_[KEY_COUNT];
  SteerPulseConfig pulse_ = DEFAULT_STEER_PULSE;

  // Hysteresis memory.
  bool leftOn_ = false, rightOn_ = false, throttleOn_ = false, brakeOn_ = false;

  // Pulse steering.
  int8_t steerDir_ = 0;
  double steerMag_ = 0;
  int8_t pulseDir_ = 0;
  bool pulseOn_ = false;
  double pulseChangedAt_ = -INFINITY;
  double pulseErr_ = 0;  // sigma: ms of "owed" key-down time
  double pulseLastT_ = NAN;
  double duty_ = 0;

  /**
   *   duty = |steering| / fullAt       ≥ 1 → hold solid
   *   pwm:   on = duty × period, off = period − on, each ≥ minPulseMs
   *          (no room for a ≥ minPulseMs gap → hold solid)
   *   sigma: owe += (duty − on) × dt;  after ≥ minPulseMs in a state,
   *          press when owed time ≥ 0, release when ≤ 0
   */
  bool runPulser(double now) {
    const SteerPulseConfig &p = pulse_;
    // Cap dt so a long pause between ticks can't build up a huge debt.
    const double dt = isnan(pulseLastT_) ? 0 : fmin(fmax(now - pulseLastT_, 0.0), 50.0);
    pulseLastT_ = now;

    if (steerDir_ == 0) {
      resetPulse();
      pulseLastT_ = now;
      return false;
    }
    if (steerDir_ != pulseDir_) {
      // New direction: start a fresh pulse train.
      resetPulse();
      pulseLastT_ = now;
      pulseDir_ = steerDir_;
    }

    const double duty = fmin(steerMag_ / p.fullAt, 1.0) * p.maxDuty;
    duty_ = duty;
    if (duty >= 1) return setPulse(true, now);

    const double held = now - pulseChangedAt_;
    const double min = p.minPulseMs;

    if (p.mode == SteerMode::Pwm) {
      const double onMs = fmax(duty * p.periodMs, min);
      const double offMs = p.periodMs - onMs;
      if (offMs < min) return setPulse(true, now);
      if (pulseOn_ ? held >= onMs : held >= offMs) setPulse(!pulseOn_, now);
      return pulseOn_;
    }

    // sigma
    const double limit = 10 * min;
    pulseErr_ = fmin(fmax(pulseErr_ + (duty - (pulseOn_ ? 1 : 0)) * dt, -limit), limit);
    if (held >= min) {
      if (pulseOn_ && pulseErr_ <= 0) setPulse(false, now);
      else if (!pulseOn_ && pulseErr_ >= 0) setPulse(true, now);
    }
    return pulseOn_;
  }

  bool setPulse(bool on, double now) {
    if (on != pulseOn_) {
      pulseOn_ = on;
      pulseChangedAt_ = now;
    }
    return on;
  }

  void resetPulse() {
    pulseDir_ = 0;
    pulseOn_ = false;
    pulseChangedAt_ = -INFINITY;  // the first pulse of a new train may start immediately
    pulseErr_ = 0;
    pulseLastT_ = NAN;
    duty_ = 0;
  }

  void want(uint8_t key, bool on) {
    // OR, not assign: if two inputs share a key, either one keeps it down.
    if (on) keys_[key].want = true;
  }
};
