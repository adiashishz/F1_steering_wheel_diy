# Controller protocol — v1

The contract between the tablet and the ESP32. The mock server in
`mock-esp32/` implements it (Phase 6–7); the real firmware must implement
it the same way.

Source of truth is the code in `protocol/src/`. If this doc and the code
disagree, the code wins — fix the doc.

---

## 1. Transport

- **WebSocket**, text frames, one JSON object per frame.
- Tablet is the client. ESP32 is the server (default port `8080`).
- Every message has `type` (what it is) and `version` (protocol version, currently `1`).
- Max message size **4096 chars**. A state packet is ~165.

---

## 2. Connection flow

```
tablet                                         ESP32
  │── hello ────────────────────────────────►  │  check version, remember sessionId
  │◄──────────────────────────── hello_ack ──  │  "accepted, watchdog is 150 ms"
  │── state (seq 0) ────────────────────────►  │  first fresh packet → output may go live
  │── state (seq 1) ────────────────────────►  │
  │── state …  100×/sec ────────────────────►  │  → key down / key up
  │── ping ─────────────────────────────────►  │
  │◄───────────────────────────────── pong ──  │  tablet measures latency
  │◄─────────────────────────────── status ──  │  ~5×/sec: what the ESP32 is holding
  │           … silence > 150 ms …             │  → ESP32 RELEASES EVERY KEY
  │── bye ──────────────────────────────────►  │  clean disconnect
```

The server's connection states:

| State | Meaning | Output |
|---|---|---|
| `PENDING` | socket open, no `hello` yet | all keys released |
| `AWAITING_FRESH` | `hello` accepted, waiting for `state` with `seq: 0` | all keys released |
| `LIVE` | receiving valid state | keys follow state |
| `TRIPPED` | watchdog fired | all keys released until a new session |

---

## 3. Messages

### Tablet → ESP32

**`hello`** — first message on every connection.
```json
{
  "type": "hello", "version": 1,
  "sessionId": "8f3a2c01-…",
  "client": { "app": "wheeldiy-tablet", "appVersion": "0.1.0" },
  "mode": "gyro-pedals",
  "actionIds": ["gearUp", "gearDown", "drs", "ers", "mfd", "radio"],
  "desiredSendRateHz": 100
}
```
`sessionId` is new and random for every connection. `mode` is one of
`touch-pedals`, `gyro-pedals`, `hybrid` (informational — the ESP32 doesn't
change behaviour by mode).

**`state`** — the stream, ~100×/sec, also sent while disarmed.
```json
{
  "type": "state", "version": 1,
  "sessionId": "8f3a2c01-…",
  "seq": 24981,
  "timestamp": 183021.4,
  "armed": true,
  "steering": -0.42,
  "throttle": 0.81,
  "brake": 0,
  "buttons": { "gearUp": false, "gearDown": false, "drs": true, "ers": false }
}
```

| Field | Range | Meaning |
|---|---|---|
| `steering` | −1 … +1 | −1 full left, +1 full right |
| `throttle` | 0 … 1 | |
| `brake` | 0 … 1 | |
| `buttons` | name → bool | every bound action, true while held |
| `armed` | bool | **false → treat the whole packet as neutral** |
| `seq` | int ≥ 0 | starts at 0 each connection, counts up |
| `timestamp` | ms | tablet clock, only used for ordering / latency |

**`ping`** — every ~500 ms. `{ "type": "ping", "version": 1, "id": 7, "timestamp": 183020.1 }`

**`bye`** — optional, on clean close. `{ "type": "bye", "version": 1, "reason": "user closed" }`

### ESP32 → tablet

**`hello_ack`**
```json
{
  "type": "hello_ack", "version": 1,
  "accepted": true,
  "server": { "name": "esp32-s3", "version": "0.1.0" },
  "watchdogMs": 150,
  "maxSendRateHz": 100,
  "serverTime": 51234
}
```
If `accepted` is false, include `reason` and close.

**`pong`** — reply to `ping`, echo its `id` and `timestamp`.
`{ "type": "pong", "version": 1, "id": 7, "clientTimestamp": 183020.1, "serverTimestamp": 51240 }`

**`status`** — ~5×/sec, feeds the tablet's debug panel.
```json
{
  "type": "status", "version": 1,
  "lastSeq": 24981, "packetsPerSec": 99.8, "droppedPackets": 0,
  "outputArmed": true, "watchdogTripped": false,
  "keys": { "KeyA": true, "KeyD": false, "KeyW": true, "KeyS": false }
}
```
`lastSeq` is `-1` before any state has been accepted.

**`error`**
```json
{ "type": "error", "version": 1, "code": "version", "message": "unsupported protocol version 2", "fatal": true }
```
Codes: `version`, `handshake`, `malformed`, `stale`, `rate`. `fatal: true` →
server closes the socket and the tablet must not auto-reconnect into the same error.

---

## 4. What the firmware MUST do

These are safety rules, not suggestions (plan.md §13, §19).

1. **Boot with every key released.**
2. **Validate every packet** the way `codec.ts` does. Wrong version → `error` + close.
   Missing field or out-of-range value → drop the packet (don't clamp it).
   **Ignore fields you don't know** — that's how newer tablets stay compatible.
3. **Ignore `state` before `hello`**, and ignore `state` whose `sessionId`
   doesn't match the current `hello`. Stay neutral until `state` with `seq: 0` arrives.
4. **`armed: false` → neutral.**
5. **Watchdog:** no valid `state` for `watchdogMs` (150 ms) → release every key.
   Check this on a timer, not only when packets arrive — silence produces no packets.
6. **Apply exclusivity again** (`pedals.ts`, policy `dominant`, threshold 0.05)
   before mapping. A buggy tablet must not be able to hold throttle and brake.
7. **Map state → keys with the same logic as `keymap.ts`**, same numbers:
   press > 0.15, release < 0.10, min hold 30 ms, min gap 20 ms.
   `releaseAll` ignores min hold.
8. **Disconnect → release every key**, immediately, not after the watchdog.
9. **Physical stop:** a board button that disables all output (plan.md §19.7).

---

## 5. Key names → USB HID usage codes

The tablet and `keymap.ts` name keys by browser `KeyboardEvent.code`.
The firmware converts to USB HID usage IDs (Keyboard page `0x07`):

| Name | HID | Name | HID | Name | HID |
|---|---|---|---|---|---|
| `KeyA` | `0x04` | `KeyN` | `0x11` | `Digit1`…`Digit9` | `0x1E`…`0x26` |
| `KeyB` | `0x05` | `KeyO` | `0x12` | `Digit0` | `0x27` |
| `KeyC` | `0x06` | `KeyP` | `0x13` | `Enter` | `0x28` |
| `KeyD` | `0x07` | `KeyQ` | `0x14` | `Escape` | `0x29` |
| `KeyE` | `0x08` | `KeyR` | `0x15` | `Backspace` | `0x2A` |
| `KeyF` | `0x09` | `KeyS` | `0x16` | `Tab` | `0x2B` |
| `KeyG` | `0x0A` | `KeyT` | `0x17` | `Space` | `0x2C` |
| `KeyH` | `0x0B` | `KeyU` | `0x18` | `ArrowRight` | `0x4F` |
| `KeyI` | `0x0C` | `KeyV` | `0x19` | `ArrowLeft` | `0x50` |
| `KeyJ` | `0x0D` | `KeyW` | `0x1A` | `ArrowDown` | `0x51` |
| `KeyK` | `0x0E` | `KeyX` | `0x1B` | `ArrowUp` | `0x52` |
| `KeyL` | `0x0F` | `KeyY` | `0x1C` | `ControlLeft` | `0xE0` (modifier) |
| `KeyM` | `0x10` | `KeyZ` | `0x1D` | `ShiftLeft` | `0xE1` (modifier) |
| | | | | `AltLeft` | `0xE2` (modifier) |

Also used by F1 25's default bindings:

| Name | HID | Name | HID | Name | HID |
|---|---|---|---|---|---|
| `Comma` | `0x36` | `F1`…`F12` | `0x3A`…`0x45` | `Delete` | `0x4C` |
| `Period` | `0x37` | `Home` | `0x4A` | `End` | `0x4D` |
| `Numpad0` | `0x62` | `PageDown` | `0x4E` | | |

Firmware notes:
- Send raw HID usage codes (the ESP32 Arduino core's `pressRaw()` / `releaseRaw()`),
  not ASCII — ASCII `press('a')` depends on keyboard layout and shift state.
  Check that your core version treats `0xE0–0xE7` as modifier bits.
- A standard boot keyboard report holds **6 non-modifier keys at once**.
  Steering + throttle + a few buttons fits, but don't bind more than 6
  things you'd ever hold together.

---

## 6. Defaults

| Setting | Value | Where |
|---|---|---|
| Send rate | 100 Hz | tablet |
| Watchdog | 150 ms | ESP32 (`hello_ack.watchdogMs`) |
| Ping interval | 500 ms | tablet |
| Status rate | ~5 Hz | ESP32 |
| Key press / release thresholds | 0.15 / 0.10 | `keymap.ts` |
| Min hold / min gap | 30 / 20 ms | `keymap.ts` |
| Exclusivity | `dominant`, 0.05 | `pedals.ts` |
| Default keys | F1 25 PS5 "Keyboard Preset 1": `A` throttle, `Z` brake, `,` / `.` steer left / right; `Space` gearUp, `ShiftLeft` gearDown, `F` drs, `M` ers (Overtake/Boost), `Numpad0` mfd, `T` radio | `keymap.ts` — confirmed on PS5 2026-09-24 |

## 7. Versioning

- Adding an **optional** field → same version. Old receivers ignore it.
- Renaming/removing a field, or changing a meaning or range → bump `PROTOCOL_VERSION`.
- Receivers accept `MIN_SUPPORTED_VERSION` … `PROTOCOL_VERSION` (currently 1…1)
  and reject anything else with `error` code `version`.
