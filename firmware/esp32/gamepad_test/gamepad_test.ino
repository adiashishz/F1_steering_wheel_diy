// G.1 — experiment: does the PS5 / F1 25 accept the ESP32 as a generic USB GAMEPAD?
//
// Why: keyboard steering is on/off (a key is held or not). A gamepad stick is
// analog, so steering 0.4 could mean "40% lock" instead of "full lock".
//
// Expectation to beat: the PS5 normally only accepts DualSense and licensed
// controllers (they pass a security handshake). A generic HID gamepad may
// simply be ignored. This sketch finds out.
//
// NEVER moves anything on its own. Starts on BOOT RELEASE:
//
//   LONG press BOOT (≥ 1 s) → D-pad test, for the PS5 HOME SCREEN
//        D-pad right ×3, then left ×3 → the highlighted tile should move
//        (never presses Cross/A, so it can't open anything)
//
//   SHORT tap BOOT           → steering sweep, for F1 25 with the car STANDING STILL
//        left stick X:  25% right 2 s → 50% right 2 s → 100% right 2 s
//                       → centre 1 s → 50% left 2 s → centre
//        Watch the on-screen steering wheel: part-way turns = analog works.
//        No throttle is sent.
//
//   ANY tap WHILE running    → abort, everything centred at once
//
// Log goes to USB serial (for desk testing on the PC).

#include "USB.h"
#include "USBHIDGamepad.h"

USBHIDGamepad pad;

constexpr uint8_t BOOT_BUTTON = 0;  // LOW when pressed
constexpr uint32_t LONG_PRESS_MS = 1000;

// Declared before any function (Arduino inserts prototypes above the first one).
enum class Press { None, Short, Long };

// Axis range is -127..127. Triggers rest at -127 (fully released) so a host that
// reads them as triggers doesn't see "half pressed" at 0.
constexpr int8_t TRIGGER_RELEASED = -127;

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
    delay(2);
  }
  return true;
}

// ─── gamepad helpers (all logged) ──────────────────────────────────────────

void centreEverything(const char *why) {
  pad.send(0, 0, 0, 0, TRIGGER_RELEASED, TRIGGER_RELEASED, HAT_CENTER, 0);
  Serial.printf("%8lu  ■ centred (%s)\n", (unsigned long)millis(), why);
}

void steer(int8_t x, const char *label) {
  pad.send(x, 0, 0, 0, TRIGGER_RELEASED, TRIGGER_RELEASED, HAT_CENTER, 0);
  Serial.printf("%8lu  stick X = %4d  (%s)\n", (unsigned long)millis(), x, label);
}

bool dpadTap(uint8_t dir, const char *label) {
  pad.send(0, 0, 0, 0, TRIGGER_RELEASED, TRIGGER_RELEASED, dir, 0);
  Serial.printf("%8lu  d-pad %s\n", (unsigned long)millis(), label);
  if (!waitOrAbort(150)) return false;
  pad.send(0, 0, 0, 0, TRIGGER_RELEASED, TRIGGER_RELEASED, HAT_CENTER, 0);
  return waitOrAbort(350);
}

// ─── the two actions ───────────────────────────────────────────────────────

bool dpadTest() {
  Serial.println("--- d-pad test ---");
  for (int i = 0; i < 3; i++) if (!dpadTap(HAT_RIGHT, "right")) return false;
  for (int i = 0; i < 3; i++) if (!dpadTap(HAT_LEFT, "left")) return false;
  return true;
}

bool steeringSweep() {
  Serial.println("--- steering sweep ---");
  if (!waitOrAbort(1000)) return false;  // time to look at the screen
  steer(32, "25% right");
  if (!waitOrAbort(2000)) return false;
  steer(64, "50% right");
  if (!waitOrAbort(2000)) return false;
  steer(127, "100% right");
  if (!waitOrAbort(2000)) return false;
  steer(0, "centre");
  if (!waitOrAbort(1000)) return false;
  steer(-64, "50% left");
  if (!waitOrAbort(2000)) return false;
  return true;
}

void setup() {
  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
  pad.begin();
  USB.begin();
  delay(1500);
  centreEverything("boot");
  Serial.println("gamepad_test ready — long press = d-pad test, short tap = steering sweep");
}

void loop() {
  bool ran = false;
  bool ok = true;
  switch (readPress()) {
    case Press::Long: ran = true; ok = dpadTest(); break;
    case Press::Short: ran = true; ok = steeringSweep(); break;
    case Press::None: break;
  }
  if (ran) {
    centreEverything(ok ? "done" : "ABORTED");
    if (!ok) {
      while (digitalRead(BOOT_BUTTON) == LOW) delay(5);
      delay(500);
      readPress();  // swallow the abort's release
    }
    Serial.println("ready — long press = d-pad test, short tap = steering sweep");
  }
  delay(2);
}
