// wheel_link — see wheel_link.ino for what this does.

#include <Arduino.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <WiFi.h>
#include <esp_timer.h>

#include "USB.h"
#include "USBHIDKeyboard.h"
#include "key_machine.h"
#include "log_buffer.h"
#include "protocol.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "wheel_link: secrets.h missing. Copy secrets.example.h to secrets.h (same folder) and fill in your Wi-Fi name and password."
#endif

// --- settings -----------------------------------------------------------------

constexpr const char *SERVER_NAME = "esp32-s3";
constexpr const char *SERVER_VERSION = "0.1.0";
constexpr const char *HOSTNAME = "wheel";  // -> wheel.local
constexpr uint16_t WS_PORT = 8080;
constexpr uint32_t WATCHDOG_MS = 300;  // 150 tripped on Wi-Fi jitter with the laptop proxy hop (2026-09-26)
constexpr uint32_t MAX_SEND_RATE_HZ = 100;
constexpr uint32_t STATUS_MS = 200;       // ~5 Hz
constexpr uint32_t SUMMARY_MS = 1000;     // serial summary line
constexpr uint32_t ERROR_REPLY_MS = 1000; // at most one non-fatal error reply per second
constexpr uint32_t WIFI_RETRY_MS = 10000;
constexpr uint32_t IDLE_RELEASE_MS = 1000;  // re-send "nothing held" while idle (a lost report can't stick a key)

constexpr uint8_t BOOT_BUTTON = 0;  // LOW when pressed
constexpr uint32_t DEBOUNCE_MS = 30;

// --- globals ------------------------------------------------------------------

USBHIDKeyboard kb;
WebSocketsServer ws(WS_PORT);
KeyStateMachine keys;
JsonDocument rx;  // reused for every incoming message

struct Session {
  int16_t client = -1;  // WebSocket client number of the active session, -1 = none
  SessionState state = SessionState::Pending;
  char id[MAX_ID_LEN + 1] = "";
  int64_t lastSeq = -1;
  uint32_t lastValidAt = 0;  // millis() of the last accepted state
  uint32_t dropped = 0;      // malformed + stale/duplicate packets from the active client
  bool lastArmed = false;
  ControllerInput lastInput = NEUTRAL_INPUT;  // as received (before armed / exclusivity), for the log
};
Session sess;

bool outputEnabled = true;  // BOOT kill switch clears it; the next hello sets it again
bool wifiUp = false;
bool netStarted = false;    // mDNS + WebSocket server started (on first connect)
uint32_t wifiLastTry = 0;
// last non-fatal error reply per client, per code (0 = never)
uint32_t lastErrorAt[WEBSOCKETS_SERVER_CLIENT_MAX][4] = {};
uint8_t pendingClose = 0;   // bitmask of clients to disconnect after ws.loop() (never inside the callback)
double lastTickAt = 0;
uint32_t lastKeyActivity = 0;

// packets/sec: accepted states counted in 5 x 200 ms buckets
uint16_t pktBucket[5] = {0};
uint8_t pktBucketIdx = 0;
uint16_t pktNow = 0;
float packetsPerSec = 0;

// steer presses in the last second (pulse mode can do up to 125/s)
uint32_t steerPressAt[256];
uint8_t steerPressHead = 0;
uint16_t steerPressCount = 0;

// loop-stall guard (runs in its own task)
volatile uint32_t loopAliveMs = 0;
volatile bool stallReleased = false;

// --- helpers ------------------------------------------------------------------

/** Key machine clock: ms as a double, from the 64-bit us timer (never wraps, keeps sub-ms). */
double nowMs() { return esp_timer_get_time() / 1000.0; }

void recordSteerPress() {
  steerPressAt[steerPressHead++] = millis();
  if (steerPressCount < 256) steerPressCount++;
}

unsigned steerPressesLastSecond() {
  uint32_t now = millis();
  unsigned n = 0;
  for (unsigned i = 0; i < steerPressCount; i++) {
    uint8_t idx = (uint8_t)(steerPressHead - 1 - i);
    if (now - steerPressAt[idx] >= 1000) break;
    n++;
  }
  return n;
}

bool anyKeyDown() {
  for (uint8_t i = 0; i < KEY_COUNT; i++)
    if (keys.isDown(i)) return true;
  return false;
}

void heldKeyNames(char *out, size_t size) {
  out[0] = 0;
  size_t n = 0;
  for (uint8_t i = 0; i < KEY_COUNT && n < size; i++) {
    if (!keys.isDown(i)) continue;
    n += snprintf(out + n, size - n, "%s%s", n ? " " : "", KEYS[i].name);
  }
}

// --- USB output ---------------------------------------------------------------

/** Send key events as USB reports, in order (the machine already put releases first). */
void applyEvents(const KeyEvent *ev, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    const uint8_t hid = KEYS[ev[i].key].hid;
    if (ev[i].down) {
      // pressRaw returns 0 only when all 6 non-modifier slots are full (report not sent).
      if (kb.pressRaw(hid) == 0) logf("! USB report full, %s not pressed\n", KEYS[ev[i].key].name);
      if (ev[i].key == K_STEER_LEFT || ev[i].key == K_STEER_RIGHT) recordSteerPress();
    } else {
      kb.releaseRaw(hid);
    }
  }
  if (n) lastKeyActivity = millis();
}

void tickKeys() {
  KeyEvent ev[KEY_COUNT];
  double now = nowMs();
  lastTickAt = now;
  applyEvents(ev, keys.tick(now, ev));
}

/** Everything up NOW, in one USB report. */
void releaseAllKeys() {
  KeyEvent ev[KEY_COUNT];
  keys.releaseAll(nowMs(), ev);
  kb.releaseAll();
  lastKeyActivity = millis();
}

// --- sending ------------------------------------------------------------------

void sendDoc(uint8_t num, JsonDocument &doc) {
  char buf[768];
  size_t len = serializeJson(doc, buf, sizeof buf);
  ws.sendTXT(num, buf, len);
}

void sendError(uint8_t num, const char *code, const char *message, bool fatal) {
  JsonDocument doc;
  doc["type"] = "error";
  doc["version"] = PROTOCOL_VERSION;
  doc["code"] = code;
  doc["message"] = message;
  doc["fatal"] = fatal;
  sendDoc(num, doc);
}

/** Non-fatal errors are rate-limited, so a buggy tablet at 100 Hz doesn't get 100 replies/s. */
void sendErrorLimited(uint8_t num, const char *code, const char *message) {
  static const char *const CODES[4] = {"malformed", "handshake", "stale", "rate"};
  uint8_t c = 0;
  while (c < 3 && strcmp(CODES[c], code) != 0) c++;
  uint32_t &last = lastErrorAt[num][c];
  if (last && millis() - last < ERROR_REPLY_MS) return;
  last = millis() | 1;  // never 0
  logf("error -> client #%u: %s: %s\n", num, code, message);
  sendError(num, code, message, false);
}

void sendHelloAck(uint8_t num) {
  JsonDocument doc;
  doc["type"] = "hello_ack";
  doc["version"] = PROTOCOL_VERSION;
  doc["accepted"] = true;
  JsonObject server = doc["server"].to<JsonObject>();
  server["name"] = SERVER_NAME;
  server["version"] = SERVER_VERSION;
  doc["watchdogMs"] = WATCHDOG_MS;
  doc["maxSendRateHz"] = MAX_SEND_RATE_HZ;
  doc["serverTime"] = millis();
  sendDoc(num, doc);
}

void sendPong(uint8_t num, const PingMsg &p) {
  JsonDocument doc;
  doc["type"] = "pong";
  doc["version"] = PROTOCOL_VERSION;
  doc["id"] = p.id;
  doc["clientTimestamp"] = p.timestamp;
  doc["serverTimestamp"] = millis();
  sendDoc(num, doc);
}

bool outputArmed() { return sess.state == SessionState::Live && outputEnabled && sess.lastArmed; }

void sendStatus() {
  JsonDocument doc;
  doc["type"] = "status";
  doc["version"] = PROTOCOL_VERSION;
  doc["lastSeq"] = sess.lastSeq;
  doc["packetsPerSec"] = packetsPerSec;
  doc["droppedPackets"] = sess.dropped;
  doc["outputArmed"] = outputArmed();
  doc["watchdogTripped"] = sess.state == SessionState::Tripped;
  JsonObject k = doc["keys"].to<JsonObject>();
  for (uint8_t i = 0; i < KEY_COUNT; i++) k[KEYS[i].name] = keys.isDown(i);
  doc["steerDuty"] = keys.steerDuty();
  doc["steerPressesPerSec"] = steerPressesLastSecond();
  sendDoc((uint8_t)sess.client, doc);
}

// --- session ------------------------------------------------------------------

void closeLater(uint8_t num) { pendingClose |= (uint8_t)(1u << num); }

/** Session over (bye / disconnect / fatal error): release now, back to no session. */
void endSession(const char *why) {
  releaseAllKeys();
  logf("session ended (%s) - all keys released\n", why);
  sess.client = -1;
  sess.state = SessionState::Pending;
  sess.id[0] = 0;
  sess.lastSeq = -1;
  sess.lastArmed = false;
  sess.lastInput = NEUTRAL_INPUT;
}

void onHello(uint8_t num, const char *sessionId, JsonObjectConst msg) {
  releaseAllKeys();
  if (sess.client >= 0 && sess.client != num) {
    logf("session on client #%d replaced by client #%u\n", sess.client, num);
    closeLater((uint8_t)sess.client);
  }
  sess.client = num;
  sess.state = SessionState::AwaitingFresh;
  strlcpy(sess.id, sessionId, sizeof sess.id);
  sess.lastSeq = -1;
  sess.dropped = 0;
  sess.lastArmed = false;
  sess.lastInput = NEUTRAL_INPUT;
  keys.setSteerPulse(DEFAULT_STEER_PULSE);  // 'hold' until this session sends output_config
  if (!outputEnabled) logf("kill switch cleared by new hello\n");
  outputEnabled = true;
  sendHelloAck(num);
  logf("hello accepted: client #%u, session %.8s..., %s %s, mode %s\n", num, sess.id,
       msg["client"]["app"].as<const char *>(), msg["client"]["appVersion"].as<const char *>(),
       msg["mode"].as<const char *>());
}

void onState(const StateMsg &st) {
  if (strcmp(st.sessionId, sess.id) != 0) {  // another session's packet - ignore
    sess.dropped++;
    sendErrorLimited((uint8_t)sess.client, "stale", "state for another session");
    return;
  }
  switch (sess.state) {
    case SessionState::Pending:
    case SessionState::Tripped: return;  // neutral until a new hello
    case SessionState::AwaitingFresh:
      if (st.seq != 0) {
        sess.dropped++;
        return;
      }
      sess.state = SessionState::Live;
      logf("first state (seq 0) - LIVE\n");
      break;
    case SessionState::Live:
      if (st.seq <= sess.lastSeq) {  // old or duplicate
        sess.dropped++;
        return;
      }
      sess.dropped += (uint32_t)(st.seq - sess.lastSeq - 1);  // gap = lost on the way
      break;
  }
  sess.lastSeq = st.seq;
  sess.lastValidAt = millis();
  sess.lastInput = st.input;
  pktNow++;

  if (!st.armed || !outputEnabled) {
    // Disarm is a stop: release at once (ignoring min hold), like the mock server.
    if (sess.lastArmed && outputEnabled) releaseAllKeys();  // (kill switch already released)
    keys.update(NEUTRAL_INPUT);
  } else {
    // The tablet already did this; again so a buggy tablet can't hold both pedals.
    ControllerInput in = st.input;
    enforceExclusivityDominant(in);
    keys.update(in);
  }
  sess.lastArmed = st.armed;
  tickKeys();
}

void onOutputConfig(const SteerPulseConfig &c) {
  keys.setSteerPulse(c);  // does NOT release keys
  const SteerPulseConfig &p = keys.steerPulse();
  logf("output_config: steer %s, period %.0f ms, min pulse %.0f ms, full at %.2f, max duty %.2f\n",
       steerModeName(p.mode), p.periodMs, p.minPulseMs, p.fullAt, p.maxDuty);
}

void onText(uint8_t num, const uint8_t *payload, size_t length) {
  const bool active = num == sess.client;
  Decoded d = decodeClient(rx, payload, length);

  if (d.error == DecodeError::Version) {
    char msg[64];
    snprintf(msg, sizeof msg, "unsupported protocol version %lld", (long long)d.version);
    sendError(num, "version", msg, true);
    logf("client #%u: %s - closing\n", num, msg);
    if (active) endSession("version error");
    closeLater(num);
    return;
  }
  if (d.error != DecodeError::None) {
    if (active) sess.dropped++;
    sendErrorLimited(num, "malformed", d.detail);
    return;
  }

  switch (d.type) {
    case MsgType::Hello: onHello(num, d.sessionId, rx.as<JsonObjectConst>()); break;
    case MsgType::State:
      if (active) onState(d.state);
      else sendErrorLimited(num, "handshake", "state before hello");
      break;
    case MsgType::OutputConfig:
      if (active) onOutputConfig(d.steerPulse);
      else sendErrorLimited(num, "handshake", "output_config before hello");
      break;
    case MsgType::Ping: sendPong(num, d.ping); break;
    case MsgType::Bye:
      if (active) endSession("bye");
      break;
  }
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      memset(lastErrorAt[num], 0, sizeof lastErrorAt[num]);
      logf("client #%u connected from %s\n", num, ws.remoteIP(num).toString().c_str());
      break;
    case WStype_DISCONNECTED:
      logf("client #%u disconnected\n", num);
      if (num == sess.client) endSession("disconnect");
      break;
    case WStype_TEXT: onText(num, payload, length); break;
    case WStype_BIN:
      if (num == sess.client) sess.dropped++;
      sendErrorLimited(num, "malformed", "binary frames not supported");
      break;
    default: break;
  }
}

// --- watchdog, kill switch, stall guard ---------------------------------------

void checkWatchdog() {
  if (sess.state != SessionState::Live) return;
  uint32_t silent = millis() - sess.lastValidAt;
  if (silent <= WATCHDOG_MS) return;
  releaseAllKeys();
  sess.state = SessionState::Tripped;
  logf("## WATCHDOG: no valid state for %lu ms - all keys released, TRIPPED until a new hello\n",
       (unsigned long)silent);
}

void checkButton() {
  static bool wasDown = false;
  static uint32_t changedAt = 0;
  bool down = digitalRead(BOOT_BUTTON) == LOW;
  if (down == wasDown || millis() - changedAt < DEBOUNCE_MS) return;
  wasDown = down;
  changedAt = millis();
  if (!down) return;
  releaseAllKeys();
  outputEnabled = false;
  logf("## BOOT pressed - KILL SWITCH: all keys released, output disabled until the next hello\n");
}

/**
 * Second line of defence. The loop should come round every ~1 ms; if it hasn't for
 * WATCHDOG_MS (e.g. stuck inside the WebSockets library waiting for the rest of a frame),
 * release every key from here. The loop then syncs the key machine and trips the session.
 */
void stallGuardTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(10));
    if (!stallReleased && millis() - loopAliveMs > WATCHDOG_MS) {
      stallReleased = true;
      kb.releaseAll();
    }
  }
}

void handleStall() {
  if (!stallReleased) return;
  releaseAllKeys();
  if (sess.state == SessionState::Live) sess.state = SessionState::Tripped;
  logf("## loop stalled > %lu ms - all keys released%s\n", (unsigned long)WATCHDOG_MS,
       sess.state == SessionState::Tripped ? ", TRIPPED until a new hello" : "");
  stallReleased = false;
}

// --- Wi-Fi --------------------------------------------------------------------

// Why the last join failed, in words. Logged on each retry.
volatile uint8_t wifiLastReason = 0;

const char *wifiReasonText(uint8_t r) {
  switch (r) {
    case 0: return "no attempt yet";
    case 2: case 15: case 202: case 204: return "WRONG PASSWORD (auth / handshake failed)";
    case 201: return "NETWORK NOT FOUND (name wrong, or it's 5 GHz only - ESP32 needs 2.4 GHz)";
    case 203: return "association failed (router refused: MAC filter / too many clients?)";
    case 205: return "connection failed";
    default: return "see esp_wifi_types.h wifi_err_reason_t";
  }
}

void startWifi() {
  WiFi.onEvent(
    [](WiFiEvent_t, WiFiEventInfo_t info) { wifiLastReason = info.wifi_sta_disconnected.reason; },
    ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.setHostname(HOSTNAME);  // must come before mode()/begin()
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep adds ~100 ms latency spikes
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // returns at once; we poll status in loop()
  wifiLastTry = millis();
  logf("Wi-Fi: connecting to \"%s\"...\n", WIFI_SSID);
}

void checkWifi() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up && !wifiUp) {
    WiFi.setSleep(false);
    logf("Wi-Fi: connected, IP %s, RSSI %d dBm -> ws://%s:%u  (ws://%s.local:%u)\n", WiFi.localIP().toString().c_str(),
         WiFi.RSSI(), WiFi.localIP().toString().c_str(), WS_PORT, HOSTNAME, WS_PORT);
    if (!netStarted) {
      netStarted = true;
      if (MDNS.begin(HOSTNAME)) MDNS.addService("ws", "tcp", WS_PORT);
      else logf("mDNS failed to start (use the IP)\n");
      ws.begin();
      ws.onEvent(onWsEvent);
      ws.enableHeartbeat(2000, 1000, 2);  // reap dead TCP clients so they don't fill the 5 slots
    }
  } else if (!up && wifiUp) {
    logf("Wi-Fi: connection lost, reconnecting...\n");
    wifiLastTry = millis();
  } else if (!up && millis() - wifiLastTry > WIFI_RETRY_MS) {
    logf("Wi-Fi: still not connected (status %d, reason %u: %s), retrying\n", (int)WiFi.status(),
         (unsigned)wifiLastReason, wifiReasonText(wifiLastReason));
    WiFi.reconnect();
    wifiLastTry = millis();
  }
  wifiUp = up;
}

// --- periodic -----------------------------------------------------------------

void everyStatusTick() {
  // packets/sec over the last 5 x 200 ms
  pktBucket[pktBucketIdx] = pktNow;
  pktBucketIdx = (pktBucketIdx + 1) % 5;
  pktNow = 0;
  unsigned sum = 0;
  for (uint16_t b : pktBucket) sum += b;
  packetsPerSec = (float)sum;
  if (sess.client >= 0 && sess.state != SessionState::Pending) sendStatus();
}

void printSummary() {
  if (sess.client < 0) return;
  char held[96];
  heldKeyNames(held, sizeof held);
  const ControllerInput &in = sess.lastInput;
  logf("%s%s  %5.1f pkt/s  steer %+.2f thr %.2f brk %.2f  %s duty %.2f  %u steer presses/s  held [%s]  dropped %lu\n",
       stateName(sess.state), !outputEnabled ? " KILLED" : (sess.state == SessionState::Live && !sess.lastArmed ? " disarmed" : ""),
       packetsPerSec, in.steering, in.throttle, in.brake, steerModeName(keys.steerPulse().mode), keys.steerDuty(),
       steerPressesLastSecond(), held, (unsigned long)sess.dropped);
}

// --- setup / loop -------------------------------------------------------------

void setup() {
  pinMode(BOOT_BUTTON, INPUT_PULLUP);
  // USB first, everything released, before Wi-Fi or anything slow (plan.md 13).
  Serial.begin(115200);
  kb.begin();
  USB.begin();
  kb.releaseAll();
  Serial.setTxTimeoutMs(0);  // never let the log block the loop (log_buffer.h)

  logf("wheel_link %s - tablet -> Wi-Fi -> ESP32-S3 -> USB keyboard. Protocol v%d, ws port %u, watchdog %lu ms\n",
       SERVER_VERSION, PROTOCOL_VERSION, WS_PORT, (unsigned long)WATCHDOG_MS);
  logf("BOOT button = kill switch\n");

  keys.setSteerPulse(DEFAULT_STEER_PULSE);
  startWifi();

  loopAliveMs = millis();
  xTaskCreatePinnedToCore(stallGuardTask, "stallGuard", 3072, nullptr, 2, nullptr, ARDUINO_RUNNING_CORE);
}

void loop() {
  static uint32_t lastWifiCheck = 0, lastStatus = 0, lastSummary = 0;
  loopAliveMs = millis();
  handleStall();

  if (netStarted) ws.loop();
  while (pendingClose) {
    uint8_t num = __builtin_ctz(pendingClose);
    pendingClose &= (uint8_t)~(1u << num);
    ws.disconnect(num);
  }

  if (nowMs() - lastTickAt >= 1.0) tickKeys();  // pulses need a ~1 ms tick
  checkWatchdog();
  checkButton();

  uint32_t now = millis();
  if (now - lastWifiCheck >= 100) {
    lastWifiCheck = now;
    checkWifi();
  }
  if (now - lastStatus >= STATUS_MS) {
    lastStatus = now;
    everyStatusTick();
  }
  if (now - lastSummary >= SUMMARY_MS) {
    lastSummary = now;
    printSummary();
  }
  if (!anyKeyDown() && now - lastKeyActivity >= IDLE_RELEASE_MS) {
    kb.releaseAll();  // idempotent; heals a release report the host may have missed
    lastKeyActivity = now;
  }
  drainLog();
}
