# ESP32-S3 firmware

Board: **ESP32-S3 N16R8** (16 MB flash, 8 MB octal PSRAM), rev 2. Verified in F.1.

Real firmware hasn't started yet. The sketches here are the plan.md §1 gate
tests (Stages 1–3). Once the gate passes, the real firmware must mirror two files from
`protocol/src/` exactly, because the mock server runs them and the tablet was tuned against them:

- `keymap.ts` — state → key down/up (hysteresis, min hold/gap, release-all)
- `pedals.ts` — throttle/brake exclusivity

## Sketches

| Folder | Piece | What |
|---|---|---|
| `serial_hello/` | F.1 ✅ | Prints "Hello from ESP32-S3" + chip report every second |
| `hid_keyboard_test/` | F.2 ✅ | USB keyboard. Tap BOOT → types HELLO, holds W/A/S/D 500 ms each, then W+A together, then releases everything. Tap BOOT again mid-test to abort |

| `ps5_drive_test/` | F.3 ✅ | **The gate.** Long press BOOT → types HELLO. Short tap → accelerate 3 s, + left 1.5 s, + right 1.5 s, coast, brake 2 s, release all. Tap again = abort. Uses F1 25's bindings |

| `gamepad_test/` | G.1 ❌ | Generic USB gamepad. Long press → D-pad right×3/left×3. Short tap → stick X sweep 25/50/100%, centre, −50% |

| `pulse_steer_test/` | P.1 ❌ | Pulses "." at 25/50/75% duty (80 / 160 ms periods) to fake part-way steering |

| `wheel_link/` | F.4–F.7 (experiment) | The real link: Wi-Fi WebSocket server (protocol v1) → `keymap.ts` port → USB keyboard. Not yet tested on hardware |

**P.1 result (2026-09-24): FAILED.** F1 25 doesn't average the pulses. The wheel follows each one
and shakes back and forth, which is unplayable. Keyboard steering on PS5 is on/off only.

**G.1 result (2026-09-24): FAILED, as expected.** Linux sees a correct analog gamepad
(`USB HID v1.11 Gamepad`; stick values verified — the 25% step reads 17.5% only because the Linux
joystick driver adds its own ±15/127 dead zone). **The PS5 ignores it completely**, in the menus and
in F1 25. PS5 only talks to controllers that pass Sony's authentication. For analog steering, see
the Access Controller route in the plan.

**Note:** the board currently holds `gamepad_test`. Reflash `ps5_drive_test` to get the keyboard back.

**F.3 result (2026-09-24): PASSED.** The PS5 accepts the ESP32 as a keyboard (HELLO typed in
PS5 search), and F1 25 drives from it in Time Trial: throttle, steer left, steer right and brake all confirmed.
The first attempt used W/A/S/D and only "accelerate" happened, because F1 25's A *is* accelerate.
Fixed by sending the game's own bindings (table below). The keyboard route of plan.md §1 is confirmed.

Gotchas found: a **charge-only USB-A→C cable** made the PS5 see nothing (use a data cable).
The board's RGB LED (GPIO 48) doesn't light on this clone, so it's probably not connected; the sketch doesn't depend on it.

F.2 result on Linux (2026-09-24): recognised as `USB HID v1.11 Keyboard`, output
`HELLO wwaassddwaa`. Holds are 501 ms, releases are clean, and two keys at once work.
The doubled letters are the PC's own key repeat, which shows the key was held rather than tapped.

Each sketch has a `sketch.yaml` holding its board settings, so no flags are needed.

## wheel_link

Tablet → Wi-Fi → ESP32 → USB keyboard. Implements `protocol/controller-state.md`; `key_machine.h`
is a C++ port of `keymap.ts` + `pedals.ts` (cross-checked against the TS: identical key events over
20k ticks in hold / pwm / sigma). Code is in `wheel_link_main.cpp`, not the `.ino` (see below).

```bash
cp firmware/esp32/wheel_link/secrets.example.h firmware/esp32/wheel_link/secrets.h   # fill in Wi-Fi (2.4 GHz); gitignored
arduino-cli lib install "WebSockets@2.7.2" "ArduinoJson@7.4.3"   # Markus Sattler's WebSockets; these versions build on core 3.3.12
arduino-cli compile firmware/esp32/wheel_link
arduino-cli upload  -p /dev/cu.usbmodem… firmware/esp32/wheel_link   # BOOT/RST routine below
arduino-cli monitor -p /dev/cu.usbmodem… -c baudrate=115200
```

- Tablet connects to `ws://wheel.local:8080` (mDNS) or `ws://<IP>:8080`. The IP is in the serial log.
- Serial log: boot banner, Wi-Fi status + IP, client connect/disconnect, hello accepted,
  `output_config` changes, watchdog trips, kill switch, and one summary line per second while a tablet is
  connected (state, pkt/s, steering/throttle/brake, steer mode + duty, steer presses/s, held keys, dropped).
  Individual key events are not logged.
- **BOOT = kill switch**: releases every key, output stays off until the tablet sends a new `hello`.
- Watchdog 150 ms: no valid `state` → everything released, `TRIPPED` until a new `hello`.
- Only one tablet at a time. A new `hello` takes over (old session's keys released, old socket closed).

**Why the code isn't in the `.ino`:** on the Mac, `~/Library/Arduino15/packages/builtin/tools/ctags/5.8-arduino11/ctags`
is a symlink to universal-ctags. arduino-cli's prototype generator can't read its output and inserts broken
prototypes (no return type), so any `.ino` that defines functions fails to compile (the older test sketches too).
`.cpp` files skip that step.

## F1 25 on PS5 — "Keyboard Preset 1" default bindings

Read off the in-game Controls screen on 2026-09-24, with the ESP32 connected as the keyboard.
F1 25 does **not** use W/A/S/D. **A is Accelerate**, S is Push to Talk.

| Action | Key | HID |
|---|---|---|
| Accelerate | `A` | `0x04` |
| Brake / Reverse | `Z` | `0x1D` |
| Steer Left | `,` comma | `0x36` |
| Steer Right | `.` period | `0x37` |
| Gear Up | `Space` | `0x2C` (also Clutch) |
| Gear Down | `Left Shift` | `0xE1` |
| DRS / S Mode | `F` | `0x09` (also Pit Limiter) |
| Overtake / Boost | `M` | `0x10` |
| Radio / Voice Commands | `T` | `0x17` |
| Push to Talk | `S` | `0x16` |
| MFD | `Keypad 0` | `0x62` |
| MFD / Menu navigate | `↑ ↓ ← →` | `0x52 0x51 0x50 0x4F` |
| Accept / Advance | `Enter` | `0x28` |
| Pause / Back | `Esc` | `0x29` |
| Next Camera | `C` | `0x06` |
| Replay / Rewind | `X` | `0x1B` |
| Look fwd / back / left / right | `Home` / `End` / `Delete` / `Page Down` | `0x4A` / `0x4D` / `0x4C` / `0x4E` |
| Options button | `Tab` | `0x2B` |
| L1 / R1 / L2 / R2 | `F5` / `F6` / `F7` / `F8` | `0x3E`–`0x41` |
| MFD shortcuts: setup / pit / damage / engine / temps | `F1`–`F5` | `0x3A`–`0x3E` |

The game's **Controls → Test Buttons** screen shows which key it receives, which is useful for checking bindings.

## Toolchain

- `arduino-cli` 1.5.1 in `~/.local/bin`
- Core `esp32:esp32@3.3.12` (ESP-IDF 5.5.5)
- Your user must be in the `dialout` group (it is)

```bash
arduino-cli compile  firmware/esp32/serial_hello
arduino-cli upload   firmware/esp32/serial_hello
arduino-cli monitor  -p /dev/ttyACM0 -c baudrate=115200
```

## Uploading: the BOOT / RST routine

On this setup the automatic reset **doesn't work** over the native USB port.
esptool resets the chip, the port disconnects and reconnects, esptool loses it,
and you get `Could not configure port: (5, 'Input/output error')`.
(ModemManager on Fedora probing new serial ports doesn't help.)

What works every time:

1. **Hold BOOT**, press and release **RST**, then release BOOT → board waits in upload mode
2. `arduino-cli upload …`
3. **Press RST once** (no BOOT) → the new program starts

If the serial output says `boot:0x0 (DOWNLOAD…) waiting for download`, the
board is still in upload mode. Do step 3.

Possible permanent fix (not applied, needs sudo): a udev rule so ModemManager
ignores Espressif devices, e.g. `ENV{ID_VENDOR_ID}=="303a", ENV{ID_MM_DEVICE_IGNORE}="1"`.

## Board settings used (`sketch.yaml`)

| Option | Value | Why |
|---|---|---|
| `FlashSize` | `16M` | N16. The default assumes 4 MB |
| `PSRAM` | `opi` | R8 = octal PSRAM. The default is off |
| `PartitionScheme` | `app3M_fat9M_16MB` | Uses the 16 MB |
| `USBMode` | `hwcdc` | Native port = serial + JTAG (F.1). **F.2 changes this to USB-OTG for the keyboard** |
| `CDCOnBoot` | `cdc` | `Serial.print` goes out the native USB port |
