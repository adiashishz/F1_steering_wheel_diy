// pad_bridge — the ESP32 as a "dumb DualSense" on the Mac's USB, fed by the Mac server.
//
//   tablet ──ws──► Mac server ──USB serial: "P lx ly rx ry l2 r2 hat btn\n"──► ESP32
//                                                                             │ DualSense reports, 250 Hz
//                                         Mac ◄── USB HID (054C:0CE6) ────────┘ → PS Remote Play → PS5
//
// The Mac decides EVERYTHING (which stick steers, which button is DRS …), so a
// mapping change never needs a reflash. This board only renders the last line.
//
// Serial in (one per line, decimal):
//   P lx ly rx ry l2 r2 hat btn     sticks 0..255 (128 = centre), triggers 0..255,
//                                   hat 0..7 (N, NE … NW) or 8 = released, btn = bit mask (BTN_* in dualsense.h)
// Plus single-letter debug commands, for driving menus by hand (no newline needed),
// ignored while the bridge is live:
//   x o q t p O C   cross circle square triangle PS options create      u d l r   D-pad      c   centre
//
// SAFETY: once a P line has been seen, going 250 ms without one centres everything
// (sticks centre, triggers and buttons released) until the next P line. The Mac
// server has its own watchdog for the tablet; this one covers the Mac server dying.

#include "dualsense.h"

constexpr uint32_t SERIAL_WATCHDOG_MS = 250;
constexpr uint32_t REPORT_EVERY_MS = 4;

bool bridgeLive = false;
uint32_t lastLineAt = 0;
uint32_t lines = 0;

char lineBuf[64];
uint8_t lineLen = 0;
bool inLine = false;

void centre() { st = State(); }

void hold(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) { sendState(); delay(REPORT_EVERY_MS); }
}

void tap(uint32_t bit, const char *name) {
  Serial.printf("%8lu  press %s\n", (unsigned long)millis(), name);
  st.buttons |= bit; hold(150); st.buttons &= ~bit; hold(250);
}

void hatTap(uint8_t dir, const char *name) {
  Serial.printf("%8lu  d-pad %s\n", (unsigned long)millis(), name);
  st.hat = dir; hold(150); st.hat = 8; hold(250);
}

/** "P lx ly rx ry l2 r2 hat btn" → st. Malformed or out of range → ignored. */
void parseLine() {
  lineBuf[lineLen] = 0;
  unsigned v[7];
  unsigned long btn;
  if (sscanf(lineBuf, "P %u %u %u %u %u %u %u %lu", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &btn) != 8) return;
  for (int i = 0; i < 6; i++) if (v[i] > 255) return;
  if (v[6] > 8) return;
  st.lx = v[0]; st.ly = v[1]; st.rx = v[2]; st.ry = v[3]; st.l2 = v[4]; st.r2 = v[5];
  st.hat = v[6];
  st.buttons = btn & 0x7FFF0;  // only the bits the report carries
  lastLineAt = millis();
  lines++;
  if (!bridgeLive) {
    bridgeLive = true;
    Serial.printf("%8lu  bridge LIVE (first P line)\n", (unsigned long)millis());
  }
}

void debugCommand(char c) {
  switch (c) {
    case 'x': tap(BTN_CROSS, "cross"); break;
    case 'o': tap(BTN_CIRCLE, "circle"); break;
    case 'q': tap(BTN_SQUARE, "square"); break;
    case 't': tap(BTN_TRIANGLE, "triangle"); break;
    case 'p': tap(BTN_PS, "PS"); break;
    case 'O': tap(BTN_OPTIONS, "options"); break;
    case 'C': tap(BTN_CREATE, "create"); break;
    case 'u': hatTap(0, "up"); break;
    case 'r': hatTap(2, "right"); break;
    case 'd': hatTap(4, "down"); break;
    case 'l': hatTap(6, "left"); break;
    case 'c': centre(); Serial.printf("%8lu  centred\n", (unsigned long)millis()); break;
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (inLine) {
      if (c == '\n' || c == '\r') {
        parseLine();
        inLine = false;
      } else if (lineLen < sizeof lineBuf - 1) {
        lineBuf[lineLen++] = c;
      } else {
        inLine = false;  // too long: drop it
      }
    } else if (c == 'P') {
      inLine = true;
      lineLen = 0;
      lineBuf[lineLen++] = c;
    } else if (!bridgeLive) {
      debugCommand(c);  // hand-driving only: while bridged, stray bytes can't press buttons
    }
  }
}

void setup() {
  USB.VID(0x054C);
  USB.PID(0x0CE6);
  USB.firmwareVersion(0x0100);
  USB.productName("DualSense Wireless Controller");
  USB.manufacturerName("Sony Interactive Entertainment");
  Serial.begin(115200);
  hid.begin();
  USB.begin();
  delay(1000);
  Serial.println("pad_bridge ready — waiting for P lines from the Mac server");
}

void loop() {
  readSerial();

  uint32_t now = millis();
  if (bridgeLive && now - lastLineAt > SERIAL_WATCHDOG_MS) {
    centre();
    bridgeLive = false;
    Serial.printf("%8lu  ## no P line for %lu ms - centred, waiting for the Mac server\n", (unsigned long)now,
                  (unsigned long)(now - lastLineAt));
  }

  static uint32_t lastReport = 0;
  if (now - lastReport >= REPORT_EVERY_MS) {
    lastReport = now;
    sendState();
  }

  static uint32_t lastSummary = 0;
  if (bridgeLive && now - lastSummary >= 1000) {
    lastSummary = now;
    Serial.printf("%8lu  %lu lines/s  L(%u,%u) R(%u,%u) L2 %u R2 %u hat %u btn %05lX\n", (unsigned long)now,
                  (unsigned long)lines, st.lx, st.ly, st.rx, st.ry, st.l2, st.r2, st.hat, (unsigned long)st.buttons);
    lines = 0;
  }
  delay(1);
}
