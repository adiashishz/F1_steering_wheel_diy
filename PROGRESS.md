# Tablet Controller UI — Implementation Plan

## Context

`plan.md` describes a tablet → ESP32-S3 → PS5 controller for F1 25. Section 1 of that plan is a hard gate: **it is unknown whether F1 25 on PS5 accepts keyboard input at all.**

The ESP32-S3 is on hand, so that gate *can* be tested — but the user's call is to build the tablet UI first. That is fine, because the tablet app is the half that doesn't depend on the answer. The critical constraint is `plan.md` §15 — nothing in the tablet app may know that a keyboard exists. The app produces a device-agnostic `ControllerState`; key codes and key up/down live behind a seam. If the gate fails and we pivot to gamepad HID or the Access Controller, the diff is confined to one file plus firmware.

Because the hardware exists, the §1 gate can be run at any point in parallel with the UI phases (flash the Stage 1/2 sketches, plug into the PS5, try F1 25). Nothing in phases 0–11 blocks on the result, and nothing has to be rewritten if it fails.

Second constraint: **desktop-first**. Every phase must be verifiable in a desktop browser with a mouse and keyboard. Real gyro, LAN and HTTPS slot into interfaces that already exist.

Decisions made: React + Vite + TypeScript PWA · full tablet app with mock output · Node WebSocket mock ESP32 · desktop browser dev target · **phased delivery, one phase at a time** · **no unit tests for now** (math stays pure so tests can be added later without restructuring).

Working style for this project: explanations in plain English, short, paired with the actual code logic. No essays.

---

## Architecture

```
SensorSource ─┐
              ├─► RawInputFrame ─► ControlMapper(mode) ─► ControllerState ─► OutputDevice ─► Transport
TouchSnapshot ─┘        ▲                   ▲                     │
                  AxisProcessor        AppConfig +             [SEAM]
                 (deadzone/curve/      Calibration       everything left of here
                  sens/EMA)                              is output-agnostic
```

Three seams:

1. **`OutputDevice`** — the §15 seam. `ControllerState` in, nothing out. `WebSocketOutput` / `LoopbackOutput` / `NullOutput` today; `GamepadOutput`, `AccessControllerOutput` later. Swapped in one line in `runtime.ts`.
2. **`SensorSource`** — pull-model, so `SimulatedSensorSource` (sliders/drag pad) and `DeviceOrientationSource` are interchangeable. This is what makes desktop-first possible.
3. **`ControlMapper`** — modes A/B/C are three implementations of one interface, selected by config.

### Repo layout

pnpm workspace. `protocol/` is a source-only package (`main: src/index.ts`, no build step) consumed by Vite for the tablet and `tsx` for the mock server — so the key state machine cannot drift between browser loopback, mock server, and the future firmware.

```
wheelDIY/
├── plan.md                  (existing, untouched)
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  .gitignore  README.md
│
├── protocol/                # SHARED: browser + node + (later) hand-ported to C++
│   ├── controller-state.md              # wire doc (plan.md §16 asks for this)
│   └── src/{index,version,messages,controllerState,codec,math,axis,pedals,keymap}.ts
│
├── tablet/
│   ├── vite.config.ts  index.html  public/icons
│   └── src/
│       ├── core/            # HOT PATH — no React imports in this folder
│       │   ├── FixedRateLoop.ts  hotStore.ts  telemetry.ts
│       │   ├── pipeline.ts  ControlLoop.ts
│       │   └── runtime.ts               # COMPOSITION ROOT
│       ├── sensors/         # types, orientationMath, DeviceOrientationSource,
│       │                    # SimulatedSensorSource, permissions, registry
│       ├── input/           # touchState, usePedalPointer, useButtonPointer,
│       │                    # keyboardSim, releaseGuards
│       ├── controls/        # mappers/{ModeA,ModeB,ModeC}, arming, calibration
│       ├── output/          # OutputDevice, WebSocketOutput, LoopbackOutput, NullOutput
│       ├── network/         # Transport, WebSocketTransport, backoff, latency, linkWatchdog
│       ├── config/          # schema, fieldSpecs, defaults, migrations, storage, configStore
│       ├── platform/        # capabilities, wakeLock, fullscreen, orientationLock
│       ├── styles/          # tokens.css, global.css
│       └── ui/              # screens/, drive/, debug/, settings/, sim/, overlays/, hooks/
│
├── mock-esp32/              # Node WS server that behaves like the firmware will
│   └── src/{index,cli,server,session,watchdog,metrics,dashboard,faults}.ts
│
├── firmware/esp32/README.md # placeholder; hardware is on hand, so the §1 gate can be run in parallel
└── docs/{architecture,calibration,troubleshooting}.md
```

---

## Key design decisions

**Control loop: drift-corrected `setTimeout` @ 100 Hz. Not rAF.** rAF is capped at display refresh, suspended when backgrounded, and couples input rate to the compositor. If the loop falls >3 periods behind, re-snap rather than burst — a burst of stale state is worse than a gap.

**React stays off the hot path.** Target zero React renders/sec while driving, enforced by a dev-only render counter. Three tiers: direct DOM writes in a rAF subscriber (bars, live numbers, key pips) · `useSyncExternalStore` at 8 Hz (packet rate, latency) · normal React state (mode, arm, connection, settings). The store is ~60 hand-written lines exposing `peek()` (live mutable object) / `bump()` / `subscribeRaf` / `subscribeHz` — zustand fights mutable hot-path access.

**Allocation discipline:** the loop owns one `RawInputFrame`, one `ControllerState`, one `StateMessage` and mutates them in place. Mappers write into an out-param.

**Axis math** (in `protocol/src/math.ts` + `axis.ts`, pure, so it transliterates to C++ verbatim):

```
1. centered = wrapDeg(raw - calibration.centerDeg)
2. n = centered / rangeDeg
3. deadzone, rescaled:  n = |n|<=dz ? 0 : sign(n)*(|n|-dz)/(1-dz)   ← rescale, else a step at the edge
4. n *= sensitivity          ← before clamp, so "full lock at rangeDeg/sensitivity degrees"
5. n = clamp(n, -1, 1)
6. n = sign(n) * |n|**curve  ← after clamp; endpoints fixed, >1 softens centre
7. n = ema(n, dt, smoothingMs)  ← last, so we smooth what we actually send
8. clamp, then invert if configured
```

EMA must be frame-rate independent: `alpha = 1 - exp(-dt/tau)`, not a fixed coefficient — `dt` will jitter. `smoothingMs` is a real time constant. **Smoothing is the largest latency term we control** (total budget ≈ 20–40 ms: loop ~5 + WiFi 5–20 + parse ~1 + USB HID 1–8).

**Orientation → roll/pitch:** do *not* read `gamma` as roll. Euler angles have a gimbal singularity at `beta = ±90°`, exactly where a tablet held like a wheel lives. Build the ZXY rotation matrix, post-multiply by `screen.orientation.angle`, extract via `atan2`. Use relative `deviceorientation`, not `deviceorientationabsolute` (magnetometer drift buys nothing when we calibrate a centre ourselves).

**Throttle/brake exclusivity** (§10/§19.5): gyro pedals are exclusive structurally (one signed pitch axis). Touch pedals aren't — two fingers can hold both — so `enforceExclusivity()` runs in every mode *and* again server-side. Default policy `dominant` (zero the smaller when both exceed 0.05, ties to brake); `brake-wins` / `cancel-both` / `allow-both` configurable.

**Touch: Pointer Events exclusively, with `setPointerCapture`.** One code path for mouse and finger. `click` fires only on release (no press state); `mousedown` is single-pointer and synthetic-mouse on touch arrives ~300 ms late. **Release on `pointerup`, `pointercancel` AND `lostpointercapture`** — forgetting `pointercancel` is the single most common cause of a stuck 100% throttle. Global guards on blur / visibilitychange / pagehide. `touch-action: none` in CSS (not `preventDefault` on touchstart — those listeners are passive by default).

**Touch pedals are analog** (vertical slider → 0..1, absolute position on pointerdown), not boolean. `ControllerState` is analog regardless; a future gamepad/Access-Controller output needs the resolution, and digital-from-analog is free while the reverse means rewriting UI. `digital` mode stays configurable.

**Wire protocol: tagged JSON envelope**, keeping §17's field names verbatim on the state message. A `type` tag is required to multiplex handshake and ping (and thus to measure latency). All I/O through `codec.ts`, so JSON → binary later is one file. Messages: `hello`/`state`/`ping`/`bye` up, `hello_ack`/`pong`/`status`/`error` down.

**Watchdog authority: the server/firmware, with the tablet advisory.** Only the output side can actually stop a held key. Server ticks at 200 Hz; `now - lastValidState > watchdogMs` (150 ms default) → `releaseAll()`. Tablet independently disarms and zeroes on link loss for UX honesty, never for safety.

**Stale-state rejection:** per-connection `PENDING → AWAITING_FRESH → LIVE`. New `sessionId` (uuid) per socket, `seq` restarts at 0; the server rejects any state whose `sessionId` doesn't match the one from `hello`. Re-arm after reconnect happens automatically **only if all inputs are currently neutral** — otherwise it requires a deliberate ARM tap, so a reconnect with a finger on the pedal can't mean instant full throttle.

**While disarmed the tablet keeps sending at full rate with zeroed values and `armed: false`** — connection stays warm, watchdog never trips spuriously, arm/disarm is instant.

**Key state machine** (`protocol/src/keymap.ts` — the one file the firmware must mirror exactly): hysteresis on every axis (on 0.15 / off 0.10) plus `minHoldMs` 30 / `minGapMs` 20. Without hysteresis an axis resting on the threshold emits key down/up at the packet rate — precisely §19.6's "uncontrolled rapid keypress loops". `releaseAll()` bypasses `minHoldMs`; safety overrides chatter suppression.

**Config:** two localStorage keys — `wheeldiy.config` and `wheeldiy.calibration` (separate so "reset calibration" is one delete, and calibration is device/orientation-specific). A single `fieldSpecs.ts` table (min/max/step/default/label/unit per numeric field) generates the defaults, drives clamping, and renders every settings slider. Hand-written `sanitizeConfig` rather than zod — ~80 lines, same safety, and the table earns its keep three ways. Load must never throw: corrupt JSON → back up the raw string, boot on defaults, toast.

---

## Phases

One phase at a time; each ends in something visible in a desktop browser. I stop after each for review.

| # | Phase | Deliverable | Check it by |
|---|---|---|---|
| 0 | Workspace scaffold | pnpm workspace, 3 packages, strict TS, Vite+React boots, dark landscape shell, `firmware/` + `docs/` stubs | `pnpm -F tablet dev` → styled blank shell at :5173 |
| 1 | `@wheel/protocol` | types, messages, codec, math, `AxisProcessor`, `enforceExclusivity`, `KeyStateMachine` | `pnpm typecheck` clean. No UI yet — this is the layer firmware inherits |
| 2 | Control loop + sim sensor | `FixedRateLoop`, `hotStore`, `ControlLoop`, `SimulatedSensorSource`, `SimSensorPanel` (roll/pitch sliders + drag pad), `TelemetryPanel` | Drag the pad → live roll/pitch; loop reads ~100 Hz and holds; React render counter stays 0 |
| 3 | Axis math + live tuning | `AxisProcessor` in the pipeline, settings sliders from `fieldSpecs`, rolling raw-vs-processed scope | Step the slider → visible EMA tail; `smoothingMs=0` → instant; raise curve → centre softens; deadzone → flat region, no step at its edge |
| 4 | Loopback key output | `KeyStateMachine` running in-browser, `KeyStateView` (A/D/W/S + action keys), key-event log | **No server needed.** Sweep steering → A releases, D presses, visible hysteresis gap; park on the threshold → no chatter |
| 5 | Touch drive UI | `PedalPad` (analog), `ActionButton`, `DriveScreen` layout per §7, pointer plumbing, release guards, CSS resets | Mouse-drag a pedal → 0..1 fill + key state; DevTools device mode multi-touch → both pedals; drag off pedal → capture holds; Alt-Tab → everything releases |
| 6 | Mock ESP32 + transport | full `mock-esp32` with TTY dashboard, `WebSocketTransport`, handshake, ping/pong, `WebSocketOutput`, RTT + rate in debug panel | `pnpm dev:all` → dashboard mirrors browser, both ~100 Hz, RTT ~1 ms |
| 7 | Reliability | reconnect/backoff, link watchdog, server watchdog, session/seq gating, `ArmingMachine`, disconnect banner, fault injection flags | Hold throttle, Ctrl-C the server → all keys released, tablet disarms <250 ms; reconnect with a finger down → stays disarmed |
| 8 | Config persistence + settings | schema, fieldSpecs, defaults, migrations, storage, settings screen, save/defaults/reset-cal/reset-all | Tune → reload → survives; corrupt the localStorage value → boots on defaults, backup written |
| 9 | Real gyro source | orientation math, permission flow, source picker, `capabilities.ts`, degrade UI | Desktop shows "unsupported" → auto-falls-back to simulated. **DevTools → Sensors → Orientation** drives the real source; verify no flip near `beta=90°` |
| 10 | Modes A/B/C + calibration | three mappers + registry, mode badge, calibration screen (400 ms averaged capture, hold-still check), arming gate | A → touch pedals only; B → pitch only; C → pitch throttle + touch brake; arming in B without calibration is blocked with a stated reason |
| 11 | Final UI + PWA + platform | manifest, service worker (`registerType: 'prompt'`, suppressed while armed), wake lock, fullscreen, orientation lock, rotate overlay, §12 layout, debug toggle | `build && preview` → installable; portrait → rotate overlay; debug off → clean driving view |
| 12 | LAN + real tablet | `--host`, HTTPS cert, mixed-content notes in `docs/troubleshooting.md` | Open from the actual tablet on LAN and drive the mock server |

Phases 0–5 need nothing but a browser. **Phase 4 is the first satisfying moment** — key states responding to a mouse drag, no server, no hardware.

---

## Work pieces — checklist

One piece at a time, stop after each. Each piece is 1–4 files and has its own check.

**Phase 0 — scaffold** ✅ done

**Phase 1 — shared `protocol/`** (check: `pnpm typecheck`)
- [x] 1.1 `controllerState.ts` + `version.ts` — the state shape, neutral state, version check
- [x] 1.2 `messages.ts` + `codec.ts` — wire message types, encode/decode with validation
- [x] 1.3 `math.ts` + `axis.ts` — deadzone, sensitivity, curve, EMA smoothing, `AxisProcessor`
- [x] 1.4 `pedals.ts` — throttle/brake exclusivity rule
- [x] 1.5 `keymap.ts` — `KeyStateMachine` (hysteresis, min hold/gap, release-all)
- [x] 1.6 `controller-state.md` — plain-English wire doc

**Phase 2 — control loop + fake gyro** (check: live numbers in browser, ~100 Hz)
- [x] 2.1 `hotStore.ts` + `telemetry.ts` — fast store the loop writes to without React
- [x] 2.2 `FixedRateLoop.ts` — steady 100 Hz timer
- [x] 2.3 `sensors/types.ts` + `SimulatedSensorSource.ts` — fake roll/pitch
- [x] 2.4 `pipeline.ts` + `ControlLoop.ts` + `runtime.ts` — wire loop → state
- [x] 2.5 `SimSensorPanel` + `TelemetryPanel` + `useRafText` + render counter

**Phase 3 — steering tuning** (check: sliders visibly change steering response)
- [x] 3.1 `fieldSpecs.ts` + `defaults.ts` + in-memory config store
- [x] 3.2 `AxisProcessor` in the pipeline — roll → steering
- [x] 3.3 `AxisSettings` sliders generated from fieldSpecs
- [x] 3.4 `AxisScope` — raw vs processed live graph

**Phase 4 — keys without a server** (check: A/D/W/S light up from the fake gyro)
- [x] 4.1 `OutputDevice` + `NullOutput` + `LoopbackOutput`
- [ ] 4.2 `KeyStateView` + key-event log

**Phase 5 — touch drive screen** (check: mouse/multi-touch pedals, nothing sticks)
- [x] 5.1 `touchState.ts` + `releaseGuards.ts` (2026-09-26, lock-test slice)
- [ ] 5.2 `usePedalPointer` + `PedalPad` (analog 0..1) — digital hold pads exist in `ui/drive/PedalPad.tsx`
- [ ] 5.3 `useButtonPointer` + `ActionButton` (hold / toggle)
- [ ] 5.4 `DriveScreen` layout + `keyboardSim` (WASD on desktop)

**Phase 6 — fake ESP32 + network** (check: `pnpm dev:all`, both sides show ~100 Hz)
- [x] 6.1 mock server + `session.ts` handshake + metrics (`mock-esp32/src/{index,session,log}.ts`)
- [ ] 6.2 mock `dashboard.ts` — the §18 terminal view
- [x] 6.3 tablet transport + ping/latency — merged into `WebSocketOutput` for now
- [x] 6.4 `WebSocketOutput` + connection pill (URL via `?esp=`, no field yet)

**Phase 7 — safety / reliability** (check: kill server while holding throttle → all keys released)
- [x] 7.1 server watchdog → release all keys (mock; tablet reconnects + disarms on a trip)
- [ ] 7.2 tablet reconnect with backoff + link watchdog
- [ ] 7.3 stale-packet rejection (sessionId / seq)
- [ ] 7.4 `ArmingMachine` + ARM/DISARM strip + disconnect banner
- [ ] 7.5 fault-injection flags + run the stuck-key test 3 ways

**Phase 8 — saved settings** (check: tune → reload → still tuned)
- [ ] 8.1 `schema.ts` + `storage.ts` + `migrations.ts` + sanitize
- [ ] 8.2 Settings screen (steering / pedals / network sections)
- [ ] 8.3 `ButtonMapEditor` — action → key
- [ ] 8.4 Save / defaults / reset calibration / reset all / export-import

**Phase 9 — real gyro** (check: DevTools → Sensors drives steering)
- [x] 9.1 `orientationMath.ts` — angles → roll/pitch without the 90° flip
- [x] 9.2 `DeviceOrientationSource` + permission flow
- [ ] 9.3 `capabilities.ts` + `SourcePicker` + auto-fallback to fake gyro — basic `SensorSwitch` + "Use tablet gyro" button done

**Phase 10 — modes + calibration** (check: A/B/C behave differently; B won't arm uncalibrated)
- [ ] 10.1 three mappers + registry + `ModeBadge`
- [ ] 10.2 calibration capture + `CalibrationScreen`
- [ ] 10.3 arming gate rules

**Phase 11 — final UI + PWA** (check: installable, clean driving view)
- [ ] 11.1 final §12 layout + debug on/off
- [ ] 11.2 wake lock + fullscreen + orientation lock + rotate overlay
- [ ] 11.3 manifest + icons + service worker

**Phase 12 — real tablet** (check: drive the mock server from the tablet)
- [ ] 12.1 LAN host + HTTPS cert
- [ ] 12.2 end-to-end tablet test + troubleshooting doc

**Firmware track — real ESP32-S3** (hardware on hand)

*Part 1: the gate — weekends only (user's choice); weekdays stay on the UI track.* It decides whether the keyboard route works at all (plan.md §1).
- [x] F.1 Board setup + serial "Hello from ESP32-S3" (plan.md Stage 1; on Linux: add user to `dialout`)
- [x] F.2 USB HID keyboard: types HELLO on the PC, then clean press/release of A/D/W/S (Stage 2)
- [x] F.3 ✅ **PASSED 2026-09-24** — F1 25 on PS5 drives from the ESP32 keyboard (throttle, left, right and brake all confirmed). Needed F1 25's own bindings (A / Z / , / .), not W/A/S/D. Keyboard route confirmed → Part 2 unblocked. **Gate:** plug into PS5, drive in F1 25 with the ESP32's keys (Stage 3) → PASS: keep going · FAIL: stop, pick another output (gamepad HID / Access Controller); the tablet UI is unaffected

*Side experiment — analog steering.* Keyboard steering is on/off: any tilt past the threshold holds the key = full lock in F1 25.
- [x] G.1 ❌ **FAILED 2026-09-24, as predicted** — Linux sees a working analog gamepad (values verified), but the PS5 ignores it (no menu response, no steering in F1 25): no Sony authentication. Next analog candidate: **Access Controller + digital potentiometer** (official Sony, no auth hacking). ESP32 as a generic USB **gamepad** (`firmware/esp32/gamepad_test/`): does the PS5 / F1 25 accept it, and does a part-way stick give part-way steering? Expectation: PS5 may ignore non-licensed gamepads. Fallbacks if so: keyboard **pulse mode** (duty-cycled key, e.g. 40% on) · PS Access Controller route (plan.md §22)

- [x] P.1 ❌ **FAILED 2026-09-24** — F1 25 follows each pulse: the wheel visibly shakes, unplayable. Keyboard stays on/off only. Keyboard **pulse mode** (`firmware/esp32/pulse_steer_test/`): pulse "." at 25/50/75% duty, period 80 ms and 160 ms (≥ 20 ms on/off). Does F1 25's steering settle part-way? PASS → build pulse mode into `keymap.ts` (the `analogEmulation` seam) · FAIL → Access Controller + digital pot

- [ ] L.1 **Live lock test** (2026-09-26 build): tablet gyro / hold-chips → `wheel_link` ESP32 → pulsed steer key, tuned live (mode hold / pwm / sigma, period 10–200 ms, shortest press 4–50 ms). P.1 only tried 80/160 ms periods; the ESP32's keyboard polls at 1 ms, so shorter pulses reach the PS5. PASS → some setting gives steady part-way lock without visible shake · FAIL → keyboard steering is on/off, go analog (Access Controller). Runbook: README *Live lock test*.

*Part 2: the real firmware — after Phase 7 AND only if F.3 passed.* Mirrors the mock server, which by then is a tested spec.
- [ ] F.4 Wi-Fi + WebSocket server, `hello` / `hello_ack` handshake — written early for L.1 (`firmware/esp32/wheel_link/`), compiles, not yet run on hardware
- [ ] F.5 Port `codec.ts` validation + session states (PENDING → AWAITING_FRESH → LIVE)
- [ ] F.6 Port `keymap.ts` + `pedals.ts` → HID `pressRaw` / `releaseRaw`
- [ ] F.7 Watchdog timer (150 ms → release all) + BOOT-button kill switch + `status` messages
- [ ] F.8 End-to-end: tablet → ESP32 → PS5 → F1 25 (merges with Phase 12: serve the PWA from the ESP32)

Total: 53 pieces (45 UI + 8 firmware).

### Known blocker, deferred by design

An HTTPS page cannot open `ws://` (mixed content), and a browser will reject the ESP32's self-signed `wss://`. But `deviceorientation` requires a secure context. The likely resolution is serving the built PWA **from the ESP32 itself over HTTP**, making it same-origin and sidestepping both. This gets documented in Phase 0 and solved in Phase 12 — it does not block anything before then.

---

## Critical files

- `protocol/src/keymap.ts` — shared key state machine (hysteresis, min-hold/min-gap, release-all). The one file ESP32 firmware must mirror exactly.
- `protocol/src/messages.ts` — versioned wire contract; every boundary is defined against it.
- `protocol/src/math.ts` + `axis.ts` — steering/pedal math, pure, C++-transliterable.
- `tablet/src/core/ControlLoop.ts` — the fixed-rate hot path; where perf and fail-safe rules land.
- `tablet/src/core/runtime.ts` — composition root; the §15 output swap is a one-line change here and nowhere else.
- `tablet/src/config/fieldSpecs.ts` — single source of truth for defaults, clamping, and every settings slider.
- `mock-esp32/src/session.ts` — handshake, stale-state rejection, watchdog; the executable spec for the firmware's network layer.

---

## Verification

```bash
cd /home/skrrt/coding/wheelDIY && pnpm install

pnpm -F tablet dev                    # http://localhost:5173  (phases 0–5)
pnpm -F tablet typecheck
pnpm dev:all                          # tablet + mock server   (phases 6+)

pnpm -F mock-esp32 dev -- --latency=80 --jitter=30 --drop=0.05
pnpm -F mock-esp32 dev -- --disconnect-every=15s
pnpm -F mock-esp32 dev -- --reject-version

pnpm -F tablet build && pnpm -F tablet preview
npx websocat ws://localhost:8080      # poke the protocol by hand
curl -s localhost:8080/status | jq
```

**The most important test in the project** (phase 7), run three ways — Ctrl-C the server, `--disconnect-every`, and physically disabling Wi-Fi: all three must end with the dashboard showing every key released and the tablet disarmed. A stuck key on a disconnect is the one failure mode that matters.

Also worth doing by hand: DevTools Performance record of 5 s idle in phase 2 — zero React commits, loop at 100 ± 2 Hz, p99 period < 15 ms. If p99 is bad, that's the signal to move the loop into a Web Worker (designed for, not built).

---

## Explicitly out of scope

unit tests (math kept pure so they drop in later) · BLE transport · iPad-specific work beyond the iOS permission gesture · binary wire format · ~~PWM analog-emulation over keyboard~~ — now in `KeyStateMachine` (`steerPulse`, default `hold`) for L.1.
