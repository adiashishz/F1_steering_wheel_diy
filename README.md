# wheelDIY — tablet wheel for F1 25 on PS5

Tablet (gyro + touch) → Wi-Fi → ESP32-S3 → USB keyboard → PS5.
Full spec: [plan.md](plan.md).

> **plan.md §1 gate: PASSED.** F1 25 on PS5 accepts the ESP32 as a USB keyboard
> and drives from it (throttle, brake, steering). It uses the game's own bindings:
> `A` / `Z` / `,` / `.`, not WASD.
>
> **Limitation found:** keyboard steering is on/off only. A generic USB gamepad is
> ignored by the PS5 (no Sony authentication), and pulsing the key makes the wheel shake.
> Candidates for true analog steering: PS Remote Play bridge (chiaki-ng) or the
> PS Access Controller + digital potentiometers. Details in
> [firmware/esp32/README.md](firmware/esp32/README.md).
>
> The tablet app outputs a device-agnostic state, so switching output routes doesn't touch the UI.

## Layout

| Folder | What |
|---|---|
| `protocol/` | Shared types + math + key logic. Runs in browser, node, and (ported) firmware. |
| `tablet/` | The React PWA you hold. |
| `mock-esp32/` | Node server that pretends to be the ESP32. |
| `firmware/esp32/` | ESP32-S3 test sketches (serial, USB keyboard, PS5 drive test, gamepad, pulse). Real firmware not started. |
| `docs/` | Architecture, calibration, troubleshooting. |

## Run

```bash
pnpm install
pnpm dev          # tablet UI  → http://localhost:5173
pnpm dev:all      # tablet + mock ESP32 (from Phase 6)
pnpm typecheck
```
