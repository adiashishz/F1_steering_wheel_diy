// P.1 — experiment: can PULSING the steer key give part-way steering in F1 25?
//
// Keyboard steering is on/off. Idea: for "50% right", hold "." for half of every
// short period and release it for the other half. If F1 25's own steering ramp is
// slow enough, the wheel should settle part-way instead of snapping to full lock.
//
// Every press is ≥ 20 ms ON and ≥ 20 ms OFF (max 12.5 presses/s), so the game
// has a chance to see each one and we never produce a runaway key loop (plan.md §19.6).
//
// NEVER sends keys on its own. Starts on BOOT RELEASE:
//
//   SHORT tap  → STANDSTILL sweep (~32 s). Car stopped in Time Trial; watch the
//                on-screen steering wheel. No throttle is sent.
//        2 s pause, then period  80 ms:  25% → 50% → 75%   (3 s each, 1.5 s rest between)
//                      then period 160 ms:  25% → 50% → 75%
//                      then plain HOLD 100% for 3 s (reference: full lock)
//
//   LONG press → MOVING sweep (~12 s). Throttle held the whole time.
//        2 s straight, then period 80 ms:  25% → 50% → 100%  (3 s each)
//        Compare how tight the car turns at each step.
//
//   ANY tap WHILE running → abort, every key released at once.
//
// TIP: film the TV with your phone. The schedule above tells you which step is which.
//
// Keys = F1 25 PS5 "Keyboard Preset 1": A accelerate, "." steer right.

#include "USB.h"
#include "USBHIDKeyboard.h"

USBHIDKeyboard kb;

constexpr uint8_t BOOT_BUTTON = 0;  // LOW when pressed
constexpr uint32_t LONG_PRESS_MS = 1000;
constexpr uint8_t KEY_THROTTLE = 0x04;  // A
constexpr uint8_t KEY_RIGHT = 0x37;     // .   (PERIOD)
constexpr uint32_t MIN_ON_MS = 20;
constexpr uint32_t MIN_OFF_MS = 20;

// Declared before any function (Arduino inserts prototypes above the first one).
enum class Press { None, Short, Long };

// ─── button ────────────────────────────────────────────────────────────────

Press readPress() {
  static bool wasDown = false;
  static uint32_t changedAt = 0;
  static uint32_t downAt = 0;
  bool down = digitalRead(BOOT_BUTTON) == LOW;
  if (down == wasDown || millis() - changedAt < 30) return Press::None;
  wasDown = down;
  changedAt = millis();
  if (down) {
    downAt = millis();
    return Press::None;
  }
  return (millis() - downAt >= LONG_PRESS_MS) ? Press::Long : Press::Short;
}

bool waitOrAbort(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    if (readPress() != Press::None || digitalRead(BOOT_BUTTON) == LOW) return false;
    delay(1);
  }
  return true;
}

// ─── pulsing ───────────────────────────────────────────────────────────────

/**
 * Pulse `key` at `dutyPct` for `durationMs`.
 *   on  = period × duty, clamped to ≥ MIN_ON_MS
 *   off = period − on,   clamped to ≥ MIN_OFF_MS
 * 100% = plain hold.
 */
bool pulse(uint8_t key, uint8_t dutyPct, uint32_t periodMs, uint32_t durationMs) {
  if (dutyPct >= 100) {
    Serial.printf("%8lu  HOLD 100%% for %lu ms\n", (unsigned long)millis(), (unsigned long)durationMs);
    kb.pressRaw(key);
    bool ok = waitOrAbort(durationMs);
    kb.releaseRaw(key);
    return ok;
  }
  uint32_t on = max<uint32_t>(MIN_ON_MS, periodMs * dutyPct / 100);
  uint32_t off = max<uint32_t>(MIN_OFF_MS, periodMs - on);
  Serial.printf("%8lu  pulse %u%%  period %lu ms  (on %lu / off %lu)  for %lu ms\n", (unsigned long)millis(),
                dutyPct, (unsigned long)periodMs, (unsigned long)on, (unsigned long)off, (unsigned long)durationMs);
  uint32_t start = millis();
  while (millis() - start < durationMs) {
    kb.pressRaw(key);
    if (!waitOrAbort(on)) return false;
    kb.releaseRaw(key);
    if (!waitOrAbort(off)) return false;
  }
  return true;
}

// ─── the two sweeps ────────────────────────────────────────────────────────

bool standstillSweep() {
  Serial.println("--- standstill sweep ---");
  if (!waitOrAbort(2000)) return false;
  const uint32_t periods[] = {80, 160};
  const uint8_t duties[] = {25, 50, 75};
  for (uint32_t p : periods) {
    for (uint8_t d : duties) {
      if (!pulse(KEY_RIGHT, d, p, 3000)) return false;
      if (!waitOrAbort(1500)) return false;  // rest: wheel returns to centre
    }
  }
  return pulse(KEY_RIGHT, 100, 0, 3000);  // reference: full lock
}

bool movingSweep() {
  Serial.println("--- moving sweep ---");
  kb.pressRaw(KEY_THROTTLE);
  if (!waitOrAbort(2000)) return false;  // straight line first
  const uint8_t duties[] = {25, 50, 100};
  for (uint8_t d : duties) {
    kb.pressRaw(KEY_THROTTLE);  // keep throttle down (pulse() only touches the steer key)
    if (!pulse(KEY_RIGHT, d, 80, 3000)) return false;
  }
  return true;
}

void setup() {
  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
  kb.begin();
  USB.begin();
  delay(1500);
  kb.releaseAll();  // plan.md §13: boot with every key released
  Serial.println("pulse_steer_test ready — short tap = standstill sweep, long press = moving sweep");
}

void loop() {
  bool ran = false;
  bool ok = true;
  switch (readPress()) {
    case Press::Short: ran = true; ok = standstillSweep(); break;
    case Press::Long: ran = true; ok = movingSweep(); break;
    case Press::None: break;
  }
  if (ran) {
    kb.releaseAll();
    Serial.printf("%8lu  ■ releaseAll (%s)\n", (unsigned long)millis(), ok ? "done" : "ABORTED");
    if (!ok) {
      while (digitalRead(BOOT_BUTTON) == LOW) delay(5);
      delay(500);
      readPress();  // swallow the abort's release
    }
  }
  delay(2);
}
