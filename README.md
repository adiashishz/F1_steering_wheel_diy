# wheelDIY — tablet wheel for F1 25 on PS5

Tablet (gyro + touch) → Wi-Fi → ESP32-S3 → USB keyboard → PS5.
Full spec: [plan.md](plan.md).

> **plan.md §1 gate: PASSED.** F1 25 on PS5 accepts the ESP32 as a USB keyboard
> and drives from it (throttle, brake, steering). It uses the game's own bindings:
> `A` / `Z` / `,` / `.`, not WASD.
>
> **Limitation found:** keyboard steering is on/off only. A generic USB gamepad is
> ignored by the PS5 (no Sony authentication), and pulsing the key at 80/160 ms makes the
> wheel shake (shorter periods: see *Live lock test* below).
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
| `firmware/esp32/` | ESP32-S3 sketches: gate tests (serial, keyboard, PS5 drive, gamepad, pulse) + `wheel_link` (Wi-Fi link used by the lock test). |
| `docs/` | Architecture, calibration, troubleshooting. |

## Run

```bash
pnpm install
pnpm dev          # tablet UI  → http://localhost:5173
pnpm dev:all      # tablet + mock ESP32 on this machine
pnpm dev:all:lan  # same, but https on the LAN so a tablet can join
pnpm typecheck
```

## Live lock test (tablet → ESP32 → PS5)

Does pulsing the steer key give part-way lock in F1 25 if the period is short
enough? The scripted P.1 test only tried 80/160 ms; this one tunes it live.

1. Flash `firmware/esp32/wheel_link` (fill `secrets.h` first — see the firmware README),
   plug the ESP32 into the PS5.
2. On the laptop: `ESP32_URL=ws://wheel.local:8080 pnpm dev:lan`
3. On the tablet: open the `https://<laptop-ip>:5173` address Vite prints, accept the cert
   ([iPad notes](docs/troubleshooting.md#accepting-the-certificate)).
4. **Use tablet gyro** → hold it straight → **Set centre** → **ARM**.
5. F1 25 Time Trial, car stopped, watch the on-screen wheel. Pick **PWM** or **Sigma**,
   hold a test chip (25 / 50 / 75 ▶) and compare against 100 ▶.
   Try periods 40 → 20 ms and shortest press 10 → 5 ms.
6. **DISARM** (or tap BOOT on the ESP32) releases everything.

The ESP32 line under the meter is the board's own report (duty, presses/s, held
keys), so you can tell a game limitation from a link problem.
