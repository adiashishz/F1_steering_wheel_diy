# Tablet → ESP32-S3 → PS5 F1 25 Controller

## 0. Mission

Build a tablet-based custom controller for **F1 25 on PS5**.

The tablet provides:

- Gyroscope steering.
- Optional gyroscope throttle/brake.
- Touchscreen throttle/brake.
- Configurable touchscreen buttons for F1 controls.

The **ESP32-S3 N16R8** receives the tablet input and converts it into controller/keyboard input for the PS5.

### Target architecture

```text
                         TABLET
                ┌─────────────────────┐
                │                     │
                │ Roll → Steering     │
                │ Pitch → Pedals      │
                │ Touch → Buttons     │
                │                     │
                └──────────┬──────────┘
                           │
                     Wi-Fi / BLE
                           │
                           ▼
                   ┌───────────────┐
                   │   ESP32-S3    │
                   │     N16R8     │
                   │               │
                   │ Input mapper  │
                   │ USB HID       │
                   └───────┬───────┘
                           │ USB
                           ▼
                         PS5
                           │
                           ▼
                         F1 25
```

---

# 1. Critical Decision Gate

**Do not assume keyboard input works in the PS5 version of F1 25.**

The PS5 can recognize keyboards at the system level, but F1 25 must actually process keyboard input during gameplay.

Therefore:

> **Stage 3 is the first major gate.**

If the ESP32 can send keyboard input and F1 25 responds during an actual race/time trial:

```text
Proceed with keyboard-HID architecture.
```

If F1 25 does NOT respond:

```text
STOP expanding the keyboard implementation.

Do not build the complete tablet UI yet.

Evaluate:
1. PlayStation Access Controller expansion-port output.
2. Another verified PS5-compatible controller/adapter.
3. Gamepad HID only after verifying it works on PS5/F1 25.
```

The tablet UI and input abstraction should be designed so the output layer can later be swapped from keyboard HID to another output method.

---

# 2. Hardware

## Already ordered

- ESP32-S3 N16R8 development board.

Expected useful capabilities:

- Wi-Fi.
- Bluetooth/BLE.
- Native USB.
- 16 MB flash.
- 8 MB PSRAM.
- GPIO.
- I2C/SPI/UART.
- ADC/PWM.

## Required

- ESP32-S3 N16R8.
- USB-C data cable.
- Mac for development/programming.
- Tablet with gyroscope.
- PS5.
- F1 25.

## Do NOT buy yet

Do not buy:

- DAC.
- PlayStation Access Controller.
- DualSense donor controller.
- analog switches.
- custom PCB.
- additional microcontroller.

Only purchase additional hardware if a later architecture requires it.

---

# 3. Software Stack

## ESP32

Start with:

- Arduino IDE 2.x.
- Espressif ESP32 Arduino core.
- Native USB/TinyUSB HID.

Potential HID outputs:

- USB keyboard first.
- USB gamepad later if useful and verified.

## Tablet

Build the tablet controller as a separate application.

Preferred development order:

1. Web/PWA prototype if sensor permissions and connectivity are sufficient.
2. Native Android app if the web prototype is limiting.
3. iPad support later.

Keep the tablet UI independent of the ESP32 output implementation.

### Internal tablet architecture

```text
Sensors
  ↓
Input normalization
  ↓
Control-mode mapper
  ↓
Command/state protocol
  ↓
Network/BLE transport
```

---

# 4. Stage 1 — ESP32 Setup

## Goal

Confirm that the ESP32-S3 N16R8 can be programmed from the Mac.

### Tasks

- Install Arduino IDE.
- Install Espressif ESP32 board package.
- Connect ESP32-S3 to Mac with a data-capable USB-C cable.
- Select the correct ESP32-S3 board profile.
- Identify the correct USB port.
- Upload a minimal serial program.

### First program

```cpp
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.println("Hello from ESP32-S3");
  delay(1000);
}
```

### Acceptance test

Serial Monitor shows:

```text
Hello from ESP32-S3
Hello from ESP32-S3
Hello from ESP32-S3
...
```

### Do not proceed until

- Upload works.
- Board boots.
- Serial output is reliable.

---

# 5. Stage 2 — USB HID Keyboard

## Goal

Make the ESP32-S3 appear to the Mac as a USB keyboard.

### First test

Use the ESP32-S3 native USB interface.

Program it to type:

```text
HELLO
```

after boot.

Conceptually:

```cpp
#include "USB.h"
#include "USBHIDKeyboard.h"

USBHIDKeyboard Keyboard;

void setup() {
  Keyboard.begin();
  USB.begin();

  delay(5000);

  Keyboard.print("HELLO");
}

void loop() {}
```

Adjust the exact USB/HID configuration to match the installed ESP32 Arduino core and board.

### Acceptance test

1. Connect ESP32-S3 to Mac.
2. Open TextEdit.
3. Upload/run firmware.
4. ESP32 automatically types `HELLO`.

Then test individual keys:

```text
A
D
W
S
```

and press/release behavior.

### Required behavior

The firmware must distinguish:

```text
key down
key held
key up
```

Do not implement steering as uncontrolled repeated `press()` calls.

---

# 6. Stage 3 — ESP32 → PS5 → F1 25

## Goal

Determine whether the PS5 version of F1 25 accepts keyboard input generated by the ESP32.

### Setup

```text
ESP32-S3
   │ USB
   ▼
  PS5
   │
   ▼
 F1 25
```

Do NOT involve the tablet yet.

### Test controls

Use simple keyboard mappings.

Example:

```text
W → throttle
S → brake
A → steer left
D → steer right
```

Use whatever keyboard bindings F1 25 actually exposes on the user's setup.

### Acceptance test

Test inside an actual playable session:

- Time Trial.
- Grand Prix practice.
- Any mode where the car can be driven.

Verify:

- Throttle responds.
- Brake responds.
- Left steering responds.
- Right steering responds.

### Decision

#### If it works

Continue with Stage 4.

#### If it does not work

Stop keyboard-specific development.

Do not assume the PS5's menu keyboard support means the game supports keyboard gameplay.

Investigate the alternative output architecture.

---

# 7. Stage 4 — Tablet UI Prototype

## Goal

Build the tablet interface without gyro first.

Initial UI:

```text
┌──────────────────────────────────┐
│          F1 CONTROLLER           │
│                                  │
│ [LEFT]                  [RIGHT]  │
│                                  │
│ [BRAKE]              [THROTTLE] │
│                                  │
│ [GEAR−]    [DRS]    [GEAR+]     │
│                                  │
│ [ERS]      [MFD]     [RADIO]    │
└──────────────────────────────────┘
```

### Requirements

Buttons must support:

- press.
- release.
- visual pressed state.
- configurable key mapping.

Do not hard-code the UI to F1 controls.

Use a generic action system:

```text
Action
  ↓
Mapped key/button
```

Example configuration:

```json
{
  "throttle": "w",
  "brake": "s",
  "steer_left": "a",
  "steer_right": "d",
  "gear_up": "space",
  "gear_down": "shift",
  "drs": "d"
}
```

The actual keys must be configurable.

---

# 8. Stage 5 — Tablet → ESP32 Communication

## Goal

Transmit controller state from tablet to ESP32.

### Preferred initial transport

Use Wi-Fi + WebSocket for development because it is easy to inspect/debug.

BLE can be added later.

Architecture:

```text
Tablet
  │
  │ WebSocket
  ▼
ESP32-S3
```

### State packet

Use a compact state representation.

Example:

```json
{
  "steering": 0.0,
  "throttle": 0.0,
  "brake": 0.0,
  "buttons": {
    "gearUp": false,
    "gearDown": false,
    "drs": false,
    "ers": false
  }
}
```

Normalized analog values:

```text
-1.0 ... +1.0
```

or:

```text
0.0 ... 1.0
```

depending on the control.

### ESP32 behavior

Receive tablet state.

Convert state to keyboard events.

Example:

```text
steering < 0 → A
steering > 0 → D
throttle > threshold → W
brake > threshold → S
```

Make the keyboard output layer independent from the network layer.

---

# 9. Stage 6 — Gyroscope Steering

## Goal

Use tablet roll as steering.

```text
TABLET ROLL
     ↓
STEERING
```

Conceptual mapping:

```text
-45°                 0°                 +45°
 LEFT               CENTER              RIGHT
```

### Required controls

- Center calibration.
- Maximum steering angle.
- Dead zone.
- Sensitivity.
- Response curve.
- Smoothing.

Example defaults:

```text
Steering range: ±45°
Dead zone: 3°
Sensitivity: 1.3
Response curve: 1.5
Smoothing: 20 ms
```

These are starting values only.

### Calibration

When the user presses:

```text
CALIBRATE
```

the current roll becomes the zero/center position.

### Acceptance test

The tablet can be rotated left/right and the ESP32 receives stable normalized steering values.

---

# 10. Stage 7 — Gyro Throttle/Brake

## Goal

Allow the tablet's pitch axis to control pedals.

```text
              TABLET PITCH

                  +30°
                    │
                    ▼
              THROTTLE 100%

                   0°
                    │
                    ▼
                 NEUTRAL

                  -30°
                    │
                    ▼
                BRAKE 100%
```

Use a configurable neutral dead zone.

Example:

```text
+30° → throttle 100%
+15° → throttle 50%
 +5° → throttle 0%

 -5° → brake 0%
-15° → brake 50%
-30° → brake 100%
```

### Important

Do not allow throttle and brake to become active simultaneously.

If both exceed a threshold:

```text
Choose the dominant axis
OR
clamp the weaker value to zero.
```

Preferred initial behavior:

```text
pitch > deadzone → throttle
pitch < -deadzone → brake
otherwise → neither
```

---

# 11. Stage 8 — Control Modes

Implement three modes.

## Mode A — Touch Pedals

```text
Roll → steering
Touch → throttle
Touch → brake
Touch → buttons
```

## Mode B — Gyro Pedals

```text
Roll → steering
Pitch → throttle/brake
Touch → buttons
```

## Mode C — Hybrid

```text
Roll → steering
Pitch → throttle
Touch → brake
Touch → buttons
```

The mode must be selectable without reflashing the ESP32.

---

# 12. Stage 9 — Final UI

Suggested final layout:

```text
┌────────────────────────────────────────────┐
│              F1 TABLET WHEEL               │
│                                            │
│              STEERING: -12°                │
│                                            │
│  [DRS]                              [ERS]  │
│                                            │
│  [GEAR−]                          [GEAR+] │
│                                            │
│ ┌──────────────┐        ┌───────────────┐ │
│ │    BRAKE     │        │   THROTTLE    │ │
│ │     37%      │        │      82%      │ │
│ └──────────────┘        └───────────────┘ │
│                                            │
│       MODE: GYRO PEDALS                   │
│                                            │
│       [ CALIBRATE ] [ SETTINGS ]          │
└────────────────────────────────────────────┘
```

Show live values for debugging:

- roll.
- pitch.
- steering.
- throttle.
- brake.
- connection status.
- packet rate.

Provide a debug mode that can be disabled for normal driving.

---

# 13. Stage 10 — Reliability

## Connection watchdog

If the tablet stops communicating:

```text
No packet for 100–250 ms
        ↓
ESP32
        ↓
Release ALL keyboard keys
```

Never leave:

```text
W held
A held
D held
S held
```

after a disconnect.

## Startup safety

On boot:

```text
all keys released
throttle = 0
brake = 0
steering = center
```

Do not automatically activate throttle or steering.

## Reconnection

When tablet reconnects:

```text
require fresh state packet
        ↓
then enable input
```

Do not restore stale button states.

---

# 14. Configuration Persistence

Save:

```text
control mode
steering center
steering range
dead zone
sensitivity
response curve
smoothing
pitch center
pitch range
button mappings
network settings
```

Use ESP32 NVS/preferences or an equivalent persistent storage mechanism.

Provide:

```text
Save
Load defaults
Reset calibration
Reset all settings
```

---

# 15. Input Abstraction

The codebase must NOT couple tablet input directly to USB keyboard code.

Use an abstraction similar to:

```text
Tablet sensors/buttons
        ↓
InputState
        ↓
ControlMapper
        ↓
OutputDevice
```

Where `OutputDevice` can eventually be:

```text
KeyboardHIDOutput
GamepadHIDOutput
AccessControllerOutput
```

This is important because the PS5 keyboard route is an experiment until verified.

---

# 16. Suggested Repository Structure

```text
f1-tablet-controller/
│
├── plan.md
├── README.md
│
├── firmware/
│   └── esp32/
│       ├── src/
│       │   ├── main.cpp
│       │   ├── usb_keyboard.cpp
│       │   ├── usb_keyboard.h
│       │   ├── network.cpp
│       │   ├── network.h
│       │   ├── input_state.cpp
│       │   ├── input_state.h
│       │   └── config.cpp
│       │
│       └── platformio.ini
│
├── tablet/
│   ├── src/
│   │   ├── sensors/
│   │   ├── controls/
│   │   ├── network/
│   │   ├── ui/
│   │   └── config/
│   └── README.md
│
├── protocol/
│   └── controller-state.md
│
└── docs/
    ├── hardware.md
    ├── calibration.md
    └── troubleshooting.md
```

The exact framework can change. The architecture should not.

---

# 17. Protocol Design

Keep the protocol simple and versioned.

Example:

```json
{
  "version": 1,
  "timestamp": 123456,
  "steering": -0.42,
  "throttle": 0.81,
  "brake": 0.0,
  "buttons": {
    "gearUp": false,
    "gearDown": false,
    "drs": false,
    "ers": false
  }
}
```

Later additions should not break older firmware.

Use:

```text
protocol version
```

and reject incompatible versions cleanly.

---

# 18. Debugging Requirements

The ESP32 should expose a debug mode.

Example:

```text
WiFi: connected
Tablet: connected
Packets: 100 Hz

Steering: -0.37
Throttle: 0.82
Brake: 0.00

A: pressed
D: released
W: pressed
S: released
```

The tablet should also show:

```text
ESP32: Connected
Latency: 8 ms
Packets: 100/s
```

Do not rely on guesswork when diagnosing steering problems.

---

# 19. Safety/Fail-Safe Rules

Always:

1. Start with all outputs released.
2. Require calibration before gyro control.
3. Require a live connection before output.
4. Release all keys on communication timeout.
5. Prevent simultaneous throttle/brake unless explicitly configured.
6. Never send uncontrolled rapid keypress loops.
7. Provide a physical way to stop the ESP32 from generating input.
8. Keep debug logging available during development.

---

# 20. Development Order

Strict order:

```text
1. ESP32 setup
       ↓
2. USB serial test
       ↓
3. USB keyboard test on Mac
       ↓
4. USB keyboard test on PS5
       ↓
5. F1 25 in-game keyboard test
       ↓
       ├── FAIL → investigate alternative PS5 output
       │
       └── PASS
             ↓
6. Tablet touch UI
       ↓
7. Tablet → ESP32 network protocol
       ↓
8. Touch controls → F1
       ↓
9. Gyro steering
       ↓
10. Gyro throttle/brake
       ↓
11. Control modes
       ↓
12. Calibration/tuning
       ↓
13. Watchdog/fail-safe
       ↓
14. Final UI
       ↓
15. Packaging/documentation
```

---

# 21. Acceptance Checklist

## Hardware

- [ ] ESP32-S3 N16R8 powers on.
- [ ] Mac detects board.
- [ ] Firmware uploads.
- [ ] Serial output works.

## USB HID

- [ ] Mac recognizes ESP32 as keyboard.
- [ ] ESP32 can type text.
- [ ] ESP32 can press/release individual keys.
- [ ] No stuck keys.

## PS5

- [ ] PS5 recognizes USB device.
- [ ] F1 25 receives keyboard input, if supported.
- [ ] Actual driving controls work.
- [ ] Keyboard architecture passes the Stage 3 gate.

## Tablet

- [ ] Touch UI works.
- [ ] Tablet connects to ESP32.
- [ ] State packets are stable.
- [ ] Disconnect is detected.
- [ ] Reconnection works.

## Gyro

- [ ] Roll is stable.
- [ ] Calibration works.
- [ ] Dead zone works.
- [ ] Steering curve works.
- [ ] Smoothing works.
- [ ] Pitch throttle works.
- [ ] Pitch brake works.
- [ ] Throttle/brake cannot accidentally conflict.

## Reliability

- [ ] Disconnect releases all inputs.
- [ ] Startup produces no unintended input.
- [ ] Configuration persists.
- [ ] Reset-to-default works.

---

# 22. Future Upgrade Path

If keyboard input proves too limited:

```text
Current:

Tablet
 ↓
ESP32-S3
 ↓
USB Keyboard HID
 ↓
PS5
```

Possible future:

```text
Tablet
 ↓
ESP32-S3
 ↓
USB Gamepad HID
 ↓
PS5
```

If native gamepad HID is not accepted:

```text
Tablet
 ↓
ESP32-S3
 ↓
DAC / external input interface
 ↓
PlayStation Access Controller
 ↓
PS5
```

The tablet software and input abstraction should survive all of these changes.

---

# 23. First Task for the Coding Agent

Do NOT implement the complete project immediately.

Start with:

### Task 1

Create the ESP32 project and make the board print:

```text
Hello from ESP32-S3
```

every second.

### Task 2

Implement USB HID keyboard.

### Task 3

Make the ESP32 type:

```text
HELLO
```

on a Mac.

### Task 4

Implement controlled key press/release functions:

```text
pressKey()
releaseKey()
releaseAllKeys()
```

### Task 5

Test the ESP32 directly with the PS5.

### Task 6

Test the keys in an actual F1 25 driving session.

**Only if Task 6 succeeds should the agent begin building the tablet controller.**

---

# 24. Definition of Done

The project is complete when:

```text
Tablet
  ↓
gyro roll
  ↓
steering

Tablet
  ↓
gyro pitch
  ↓
throttle/brake

Tablet touchscreen
  ↓
F1 buttons

All inputs
  ↓
ESP32-S3 N16R8
  ↓
PS5
  ↓
F1 25
```

and the user can switch between:

```text
Touch pedals
Gyro pedals
Hybrid
```

without changing firmware.

The system must fail safely if the tablet disconnects.

---

## Important Engineering Principle

**Do not build around an unverified assumption.**

The first question is not:

> “How do we make the complete tablet controller?”

The first question is:

> **“Will F1 25 on this PS5 actually accept the keyboard input produced by our ESP32?”**

Prove that first. Everything else depends on that result.
