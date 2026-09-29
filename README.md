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
| `mock-esp32/` | Node server: the mock ESP32, and with `--serial` the real Mac → DualSense bridge. |
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

## DualSense bridge (current route — real analog steering)

Tablet → Mac → ESP32 pretending to be a **DualSense** on the Mac's USB → **PS Remote Play** → PS5.
Proven 2026-09-29: macOS and Remote Play accept it, and F1 25 steers part-way from part-way stick.
No Sony authentication is involved: Remote Play talks to the PS5 over the network.

```
tablet ──Wi-Fi──► Mac bridge ──USB serial "P …"──► ESP32 (054C:0CE6 DualSense) ──USB──► Remote Play ──► PS5
```

1. Flash `firmware/esp32/pad_bridge` (no Wi-Fi / secrets needed), plug the ESP32 into the Mac.
2. Open PS Remote Play on the Mac and connect to the PS5 (360p / Standard keeps Wi-Fi quiet).
3. `pnpm dev:bridge` → tablet opens `https://<mac-ip>:5173`.
4. **Disarmed** = menu screen (D-pad, △○✕□, L1/R1, Options — works without arming).
   **ARM** = F1 screen (gyro steering, R2/L2 pedals, gears ✕/□, DRS △, Boost ○).

Mapping lives in `mock-esp32/src/padBridge.ts` (`--steer=left|right`, `--map=drs:r1,…`), so changes never need a reflash.
The bridge logs every button change and every hole in the stream (tablet-side vs network-side).

### Tablet over USB (no Wi-Fi between tablet and Mac)

Android tablet + USB cable: `adb reverse` tunnels the page's port over the cable, so the
tablet reaches the Mac at `localhost`. localhost is a secure context (gyro works), and the
page stays on the WebSocket (TCP) — the tunnel carries no UDP, and over a cable nothing is lost.

1. Tablet: Settings → About → tap **Build number** 7× → Developer options → **USB debugging** on.
2. Plug it in, accept "Allow USB debugging?" on the tablet.
3. `adb reverse tcp:5173 tcp:5173` (again after every re-plug), then open `https://localhost:5173`.
   The status pill shows `usb`.

## Live lock test (tablet → ESP32 → PS5, keyboard route)

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
