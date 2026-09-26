// F.2 — plan.md Stage 2: the ESP32 as a USB keyboard, with clean press / hold / release.
//
// NEVER types on its own. Tap BOOT (press and release) to run the test once:
//   1. types "HELLO"
//   2. W, A, S, D one at a time: key down → held 500 ms → key up
//   3. W + A together for 500 ms (throttle + steer: two keys held at once)
//   4. releaseAll()
// Tap BOOT again DURING the test to abort → everything released at once (the physical stop).
//
// Triggers on RELEASE of BOOT, not press: the upload routine holds BOOT while
// pressing RST, so the board resets before BOOT is released → uploading can't start typing.
//
// Keys go out as raw USB HID usage codes (pressRaw), not ASCII, matching
// protocol/controller-state.md §5. "HELLO" uses print() since that's plain text.
//
// Every key event is logged over the USB serial channel that runs alongside the keyboard.

#include "USB.h"
#include "USBHIDKeyboard.h"

USBHIDKeyboard kb;

constexpr uint8_t BOOT_BUTTON = 0;  // BOOT button, LOW when pressed
constexpr uint32_t HOLD_MS = 500;
constexpr uint32_t GAP_MS = 300;

// USB HID usage IDs (keyboard page 0x07)
constexpr uint8_t HID_A = 0x04;
constexpr uint8_t HID_D = 0x07;
constexpr uint8_t HID_S = 0x16;
constexpr uint8_t HID_W = 0x1A;

// ─── button ────────────────────────────────────────────────────────────────

bool bootDown() { return digitalRead(BOOT_BUTTON) == LOW; }

// True once per tap: pressed, then released. Simple debounce.
bool bootTapped() {
  static bool wasDown = false;
  static uint32_t changedAt = 0;
  bool down = bootDown();
  if (down != wasDown && millis() - changedAt > 30) {
    wasDown = down;
    changedAt = millis();
    if (!down) return true;  // just released
  }
  return false;
}

// ─── logging + safe key helpers ────────────────────────────────────────────

const char *name(uint8_t k) {
  switch (k) {
    case HID_W: return "KeyW";
    case HID_A: return "KeyA";
    case HID_S: return "KeyS";
    case HID_D: return "KeyD";
  }
  return "?";
}

void keyDown(uint8_t k) {
  kb.pressRaw(k);
  Serial.printf("%8lu  ▼ %s down\n", (unsigned long)millis(), name(k));
}

void keyUp(uint8_t k) {
  kb.releaseRaw(k);
  Serial.printf("%8lu  ▲ %s up\n", (unsigned long)millis(), name(k));
}

void releaseEverything(const char *why) {
  kb.releaseAll();
  Serial.printf("%8lu  ■ releaseAll (%s)\n", (unsigned long)millis(), why);
}

// Wait `ms`, but return false if BOOT is tapped meanwhile (abort).
bool waitOrAbort(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    if (bootTapped()) return false;
    delay(2);
  }
  return true;
}

// ─── the test ──────────────────────────────────────────────────────────────

bool runTest() {
  Serial.println("\n=== test start ===");

  Serial.printf("%8lu  typing \"HELLO\"\n", (unsigned long)millis());
  kb.print("HELLO");
  if (!waitOrAbort(GAP_MS)) return false;

  kb.write(' ');  // separate the HELLO from the key tests in the text box
  const uint8_t keys[] = {HID_W, HID_A, HID_S, HID_D};
  for (uint8_t k : keys) {
    keyDown(k);
    if (!waitOrAbort(HOLD_MS)) return false;
    keyUp(k);
    if (!waitOrAbort(GAP_MS)) return false;
  }

  Serial.printf("%8lu  two keys at once: W + A\n", (unsigned long)millis());
  keyDown(HID_W);
  keyDown(HID_A);
  if (!waitOrAbort(HOLD_MS)) return false;
  keyUp(HID_A);
  keyUp(HID_W);

  return true;
}

void setup() {
  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
  kb.begin();
  USB.begin();  // from here the PC sees a keyboard + a serial port
  delay(1500);
  kb.releaseAll();  // plan.md §13: boot with every key released
  Serial.println("hid_keyboard_test ready — click into a text box, then TAP BOOT");
}

void loop() {
  if (bootTapped()) {
    bool finished = runTest();
    releaseEverything(finished ? "test done" : "ABORTED by BOOT");
    Serial.println("=== test end — tap BOOT to run again ===");
  }

  // Heartbeat so you can see it's alive while waiting.
  static uint32_t last = 0;
  if (millis() - last > 5000) {
    last = millis();
    Serial.printf("%8lu  waiting for BOOT tap\n", (unsigned long)millis());
  }
  delay(2);
}
