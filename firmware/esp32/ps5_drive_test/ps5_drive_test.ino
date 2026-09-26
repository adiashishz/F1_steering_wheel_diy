// F.3 — plan.md Stage 3 GATE: does F1 25 on PS5 accept the ESP32's keyboard input?
//
// NEVER sends keys on its own. Two actions, both start when BOOT is RELEASED:
//
//   LONG press BOOT (hold ≥ 1 s, then let go) → types "HELLO"
//        Step 1: PS5 menu, open a search / text box. Proves the PS5 accepts the keyboard.
//
//   SHORT tap BOOT                            → drive sequence (~10 s)
//        Step 2: F1 25 Time Trial, car on track, standing still.
//          A          3.0 s   accelerate
//          A + ,      1.5 s   accelerate + steer left
//          A + .      1.5 s   accelerate + steer right
//          (gap)      0.5 s   coast
//          Z          2.0 s   brake
//        Keys = F1 25 PS5 "Keyboard Preset 1" defaults (see ../README.md).
//          release everything → car must coast, nothing stuck
//
//   ANY tap WHILE running → abort, every key released immediately (the physical stop)
//
// LED (no serial log at the PS5, so this is your feedback):
//   dim green   ready, nothing held
//   blue        typing HELLO
//   white blink 1 s countdown before the drive sequence
//   red         keys are being held
//   yellow      just aborted (2 s), then back to green
//
// Keys go out as raw HID usage codes (pressRaw), per protocol/controller-state.md §5.
// Key log still goes to USB serial for desk testing; the PS5 ignores that channel.

#include "USB.h"
#include "USBHIDKeyboard.h"

USBHIDKeyboard kb;

constexpr uint8_t BOOT_BUTTON = 0;  // LOW when pressed
constexpr uint32_t LONG_PRESS_MS = 1000;

// USB HID usage IDs (keyboard page 0x07), matching F1 25 on PS5 "Keyboard Preset 1".
// (First run used W/A/S/D: only A did anything — it's the game's ACCELERATE key.)
constexpr uint8_t KEY_THROTTLE = 0x04;  // A       — Accelerate
constexpr uint8_t KEY_BRAKE = 0x1D;     // Z       — Brake/Reverse
constexpr uint8_t KEY_LEFT = 0x36;      // ,       — Steer Left  (COMMA)
constexpr uint8_t KEY_RIGHT = 0x37;     // .       — Steer Right (PERIOD)

// Declared before any function: Arduino's build inserts auto-generated
// prototypes above the first function, and readPress() returns this type.
enum class Press { None, Short, Long };

// ─── LED ───────────────────────────────────────────────────────────────────

void led(uint8_t r, uint8_t g, uint8_t b) { rgbLedWrite(RGB_BUILTIN, r, g, b); }
void ledReady() { led(0, 12, 0); }
void ledTyping() { led(0, 0, 40); }
void ledHolding() { led(50, 0, 0); }
void ledAborted() { led(40, 25, 0); }

// ─── button ────────────────────────────────────────────────────────────────

// Reports a press once, when BOOT is released. Debounced.
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

// ─── keys (all logged) ─────────────────────────────────────────────────────

const char *name(uint8_t k) {
  switch (k) {
    case KEY_THROTTLE: return "throttle(A)";
    case KEY_BRAKE: return "brake(Z)";
    case KEY_LEFT: return "left(,)";
    case KEY_RIGHT: return "right(.)";
  }
  return "?";
}

void keyDown(uint8_t k) {
  kb.pressRaw(k);
  ledHolding();
  Serial.printf("%8lu  ▼ %s\n", (unsigned long)millis(), name(k));
}

void keyUp(uint8_t k) {
  kb.releaseRaw(k);
  Serial.printf("%8lu  ▲ %s\n", (unsigned long)millis(), name(k));
}

void releaseEverything(const char *why) {
  kb.releaseAll();
  Serial.printf("%8lu  ■ releaseAll (%s)\n", (unsigned long)millis(), why);
}

// Wait `ms`; return false if BOOT is pressed meanwhile (abort).
bool waitOrAbort(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) {
    if (readPress() != Press::None || digitalRead(BOOT_BUTTON) == LOW) return false;
    delay(2);
  }
  return true;
}

// ─── the two actions ───────────────────────────────────────────────────────

bool typeHello() {
  ledTyping();
  Serial.printf("%8lu  typing HELLO\n", (unsigned long)millis());
  for (const char *c = "HELLO"; *c; ++c) {
    kb.write(*c);
    if (!waitOrAbort(80)) return false;  // a little slower than F.2 — console text boxes can be slow
  }
  return true;
}

bool driveSequence() {
  // 1 s countdown: time to look at the screen, and a chance to abort.
  for (int i = 0; i < 5; i++) {
    led(30, 30, 30);
    if (!waitOrAbort(100)) return false;
    led(0, 0, 0);
    if (!waitOrAbort(100)) return false;
  }

  Serial.printf("%8lu  --- accelerate ---\n", (unsigned long)millis());
  keyDown(KEY_THROTTLE);
  if (!waitOrAbort(3000)) return false;

  Serial.printf("%8lu  --- accelerate + left ---\n", (unsigned long)millis());
  keyDown(KEY_LEFT);
  if (!waitOrAbort(1500)) return false;
  keyUp(KEY_LEFT);

  Serial.printf("%8lu  --- accelerate + right ---\n", (unsigned long)millis());
  keyDown(KEY_RIGHT);
  if (!waitOrAbort(1500)) return false;
  keyUp(KEY_RIGHT);
  keyUp(KEY_THROTTLE);

  Serial.printf("%8lu  --- coast ---\n", (unsigned long)millis());
  ledReady();
  if (!waitOrAbort(500)) return false;

  Serial.printf("%8lu  --- brake ---\n", (unsigned long)millis());
  keyDown(KEY_BRAKE);
  if (!waitOrAbort(2000)) return false;
  keyUp(KEY_BRAKE);

  return true;
}

void finish(bool completed) {
  releaseEverything(completed ? "done" : "ABORTED");
  if (!completed) {
    ledAborted();
    // Wait for the finger to come off BOOT so the abort tap doesn't start a new run.
    while (digitalRead(BOOT_BUTTON) == LOW) delay(5);
    delay(2000);
    readPress();  // swallow the abort's release
  }
  ledReady();
  Serial.println("ready — long press = HELLO, short tap = drive");
}

// ─── main ──────────────────────────────────────────────────────────────────

void setup() {
  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  Serial.begin(115200);
  kb.begin();
  USB.begin();
  delay(1500);
  kb.releaseAll();  // plan.md §13: boot with every key released
  ledReady();
  Serial.println("ps5_drive_test ready — long press = HELLO, short tap = drive");
}

void loop() {
  switch (readPress()) {
    case Press::Long: finish(typeHello()); break;
    case Press::Short: finish(driveSequence()); break;
    case Press::None: break;
  }
  delay(2);
}
