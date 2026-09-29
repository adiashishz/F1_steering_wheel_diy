// Experiment: ESP32-S3 pretends to be a USB DualSense, so macOS (and PS Remote
// Play on the Mac) treat it as a real Sony controller. No Sony auth is involved:
// Remote Play talks to the PS5 over the network; the Mac only has to BELIEVE
// this is a DualSense (USB 054C:0CE6 + DualSense HID reports).
//
// Driven from the Mac over USB serial (CDC) — one char per command:
//   x cross  o circle  q square  t triangle  p PS  O options  C create
//   u d l r  D-pad tap          s  left-stick steering sweep 25/50/100% right, 50% left
//   1..9     hold stick X at 10..90% for 2 s                 c  centre everything
//   k        switch the stick 1..9 / s move: left ↔ right      n  flip direction: right ↔ left
#include <Arduino.h>
#include "USB.h"
#include "USBHID.h"
#include "USBCDC.h"

// Built with CDCOnBoot OFF, so USB doesn't start before setup() (it would lock in
// Espressif's 303a:1001 from the variant header). We start our own CDC for the
// serial commands, after setting Sony's identity.
USBCDC UsbSerial;
#define Serial UsbSerial

USBHID hid;

// DualSense USB report descriptor (report 1 = 64-byte input, 2 = output, feature reports).
static const uint8_t DS_DESC[] = {
  0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x85, 0x01,
  0x09, 0x30, 0x09, 0x31, 0x09, 0x32, 0x09, 0x35, 0x09, 0x33, 0x09, 0x34,
  0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x06, 0x81, 0x02,
  0x06, 0x00, 0xFF, 0x09, 0x20, 0x95, 0x01, 0x81, 0x02,
  0x05, 0x01, 0x09, 0x39, 0x15, 0x00, 0x25, 0x07, 0x35, 0x00, 0x46, 0x3B, 0x01,
  0x65, 0x14, 0x75, 0x04, 0x95, 0x01, 0x81, 0x42, 0x65, 0x00,
  0x05, 0x09, 0x19, 0x01, 0x29, 0x0F, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x0F, 0x81, 0x02,
  0x06, 0x00, 0xFF, 0x09, 0x21, 0x95, 0x0D, 0x81, 0x02,
  0x06, 0x00, 0xFF, 0x09, 0x22, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x34, 0x81, 0x02,
  0x85, 0x02, 0x09, 0x23, 0x95, 0x2F, 0x91, 0x02,
  0x85, 0x05, 0x09, 0x33, 0x95, 0x28, 0xB1, 0x02,
  0x85, 0x08, 0x09, 0x34, 0x95, 0x2F, 0xB1, 0x02,
  0x85, 0x09, 0x09, 0x24, 0x95, 0x13, 0xB1, 0x02,
  0x85, 0x0A, 0x09, 0x25, 0x95, 0x1A, 0xB1, 0x02,
  0x85, 0x20, 0x09, 0x26, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x21, 0x09, 0x27, 0x95, 0x04, 0xB1, 0x02,
  0x85, 0x22, 0x09, 0x40, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x80, 0x09, 0x28, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x81, 0x09, 0x29, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x82, 0x09, 0x2A, 0x95, 0x09, 0xB1, 0x02,
  0x85, 0x83, 0x09, 0x2B, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x84, 0x09, 0x2C, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0x85, 0x09, 0x2D, 0x95, 0x02, 0xB1, 0x02,
  0x85, 0xA0, 0x09, 0x2E, 0x95, 0x01, 0xB1, 0x02,
  0x85, 0xE0, 0x09, 0x2F, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0xF0, 0x09, 0x30, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0xF1, 0x09, 0x31, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0xF2, 0x09, 0x32, 0x95, 0x0F, 0xB1, 0x02,
  0x85, 0xF4, 0x09, 0x35, 0x95, 0x3F, 0xB1, 0x02,
  0x85, 0xF5, 0x09, 0x36, 0x95, 0x03, 0xB1, 0x02,
  0xC0,
};

// Input report 1 body (63 bytes after the id), offsets as in Linux hid-playstation.
struct State {
  uint8_t lx = 0x80, ly = 0x80, rx = 0x80, ry = 0x80, l2 = 0, r2 = 0;
  uint8_t hat = 8;  // 0 = N … 7 = NW, 8 = released
  uint32_t buttons = 0;  // bits: see BTN_*
} st;

// Button bits, packed into report bytes 7 (high nibble), 8 and 9.
enum : uint32_t {
  BTN_SQUARE = 1u << 4, BTN_CROSS = 1u << 5, BTN_CIRCLE = 1u << 6, BTN_TRIANGLE = 1u << 7,
  BTN_L1 = 1u << 8, BTN_R1 = 1u << 9, BTN_L2 = 1u << 10, BTN_R2 = 1u << 11,
  BTN_CREATE = 1u << 12, BTN_OPTIONS = 1u << 13, BTN_L3 = 1u << 14, BTN_R3 = 1u << 15,
  BTN_PS = 1u << 16, BTN_TOUCHPAD = 1u << 17, BTN_MUTE = 1u << 18,
};

class DualSense : public USBHIDDevice {
 public:
  DualSense() { hid.addDevice(this, sizeof(DS_DESC)); }
  uint16_t _onGetDescriptor(uint8_t *buf) override {
    memcpy(buf, DS_DESC, sizeof(DS_DESC));
    return sizeof(DS_DESC);
  }
  // Host asks for info on connect. buffer excludes the report id (TinyUSB adds it).
  uint16_t _onGetFeature(uint8_t id, uint8_t *buf, uint16_t len) override {
    uint8_t r[63] = {0};
    uint16_t n = 0;
    auto le16 = [&](int off, int16_t v) { r[off] = v & 0xFF; r[off + 1] = (v >> 8) & 0xFF; };
    auto le32 = [&](int off, uint32_t v) { for (int i = 0; i < 4; i++) r[off + i] = (v >> (8 * i)) & 0xFF; };
    switch (id) {
      case 0x05:  // calibration: gyro bias 0, ±range, accel ±8192
        n = 40;
        le16(6, 8192); le16(8, -8192); le16(10, 8192); le16(12, -8192); le16(14, 8192); le16(16, -8192);
        le16(18, 540); le16(20, 540);
        le16(22, 8192); le16(24, -8192); le16(26, 8192); le16(28, -8192); le16(30, 8192); le16(32, -8192);
        break;
      case 0x09:  // pairing info: controller MAC
        n = 19;
        r[0] = 0x11; r[1] = 0x22; r[2] = 0x33; r[3] = 0x44; r[4] = 0x55; r[5] = 0x66;
        break;
      case 0x20:  // firmware info
        n = 63;
        memcpy(r, "Jun 10 2021", 11);
        memcpy(r + 11, "10:00:00", 8);
        le16(19, 0x0003);  // hw type
        le32(23, 0x00000410);  // hardware info
        le32(27, 0x0110002A);  // firmware version
        le16(43, 0x0214);      // update version
        break;
      default:
        n = len < sizeof(r) ? len : sizeof(r);  // zeros, but answer
    }
    if (n > len) n = len;
    memcpy(buf, r, n);
    Serial.printf("%8lu  host GET feature 0x%02X (%u bytes)\n", (unsigned long)millis(), id, n);
    return n;
  }
  void _onOutput(uint8_t id, const uint8_t *, uint16_t len) override {
    static uint32_t count = 0;
    if (count++ < 3) Serial.printf("%8lu  host output report 0x%02X (%u bytes) — rumble/LED, ignored\n", (unsigned long)millis(), id, len);
  }
} ds;

void sendState() {
  static uint8_t seq = 0;
  static uint32_t ts = 0;
  uint8_t r[63] = {0};
  r[0] = st.lx; r[1] = st.ly; r[2] = st.rx; r[3] = st.ry; r[4] = st.l2; r[5] = st.r2;
  r[6] = seq++;
  r[7] = (st.hat & 0x0F) | (st.buttons & 0xF0);
  r[8] = (st.buttons >> 8) & 0xFF;
  r[9] = (st.buttons >> 16) & 0xFF;
  ts += 4000;  // sensor timestamp, µs-ish
  for (int i = 0; i < 4; i++) r[27 + i] = (ts >> (8 * i)) & 0xFF;
  r[32] = 0x80;  // touch point 1 inactive
  r[36] = 0x80;  // touch point 2 inactive
  r[52] = 0x08;  // battery ~80%, not charging
  hid.SendReport(0x01, r, sizeof(r), 5);
}

// Keep reports flowing at ~250 Hz like a real DualSense, while waiting.
void hold(uint32_t ms) {
  uint32_t start = millis();
  while (millis() - start < ms) { sendState(); delay(4); }
}

void tap(uint32_t bit, const char *name) {
  Serial.printf("%8lu  press %s\n", (unsigned long)millis(), name);
  st.buttons |= bit; hold(150); st.buttons &= ~bit; hold(250);
}

void hatTap(uint8_t dir, const char *name) {
  Serial.printf("%8lu  d-pad %s\n", (unsigned long)millis(), name);
  st.hat = dir; hold(150); st.hat = 8; hold(250);
}

bool useRightStick = false;
float direction = 1;  // +1 right, −1 left

void stickX(float frac, uint32_t ms) {  // −1 left … +1 right
  frac *= direction;
  uint8_t v = (uint8_t)constrain(128 + (int)lroundf(frac * 127), 0, 255);
  (useRightStick ? st.rx : st.lx) = v;
  Serial.printf("%8lu  %s stick X = %+.0f%% (%u)\n", (unsigned long)millis(), useRightStick ? "RIGHT" : "left", frac * 100, v);
  hold(ms);
}

void centre() { st = State(); Serial.printf("%8lu  centred\n", (unsigned long)millis()); }

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
  Serial.println("dualsense_test ready (serial: x o q t p O C u d l r s 1-9 c)");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
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
      case 's': stickX(0.25f, 2000); stickX(0.5f, 2000); stickX(1.0f, 2000); stickX(0, 1000); stickX(-0.5f, 2000); centre(); break;
      case 'c': centre(); break;
      case 'k': useRightStick = !useRightStick; Serial.printf("stick: %s\n", useRightStick ? "RIGHT" : "left"); break;
      case 'n': direction = -direction; Serial.printf("direction: %s\n", direction > 0 ? "right" : "left"); break;
      default:
        if (c >= '1' && c <= '9') { stickX((c - '0') / 10.0f, 2000); centre(); }
    }
  }
  sendState();
  delay(4);
}
