# Architecture

```
SensorSource ─┐
              ├─► RawInputFrame ─► ControlMapper(mode) ─► ControllerState ─► OutputDevice ─► Transport
TouchSnapshot ─┘
```

- **Everything left of `OutputDevice` knows nothing about keyboards.** It only
  produces `ControllerState` (steering −1..1, throttle 0..1, brake 0..1, buttons).
- **`OutputDevice`** is the swap point: loopback, WebSocket → ESP32 keyboard
  today; gamepad HID or Access Controller later if the PS5 keyboard route fails.
- **`protocol/`** is shared by the tablet, the mock server and (ported to C++)
  the firmware, so the key logic can't drift between them.

Filled in further as phases land.
