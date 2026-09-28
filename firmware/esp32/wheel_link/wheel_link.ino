// F.4-F.7 (experiment) - wheel_link: the real link. Tablet -> Wi-Fi -> this board -> USB keyboard -> PS5.
//
// The tablet connects to ws://wheel.local:8080 (or the IP printed on serial) and streams
// its controller state ~100x/sec. This board turns that into F1 25 key presses, using the
// SAME logic as protocol/src/keymap.ts + pedals.ts (ported in key_machine.h), and follows
// the wire contract in protocol/controller-state.md.
//
//   hello          -> hello_ack (watchdog 150 ms). A new hello from anyone replaces the old
//                    session, after releasing every key.
//   state seq 0    -> output goes LIVE. After that seq must go up; old / duplicate packets dropped.
//                    armed:false -> neutral, keys released at once. Throttle+brake together -> the smaller
//                    one is zeroed (tie -> brake).
//   output_config  -> steering hold / pwm / sigma pulse settings. Doesn't release keys.
//                    Until one arrives: hold.
//   ping -> pong.   bye / disconnect -> every key released at once.
//   status ~5x/sec back to the tablet: held keys, packets/s, steer duty, steer presses/s.
//
// Safety (controller-state.md section 4):
//   - boots with every key released
//   - WATCHDOG: no valid state for 150 ms -> release everything, TRIPPED until a new hello.
//     Checked every loop, not only when packets arrive. A second guard task releases the
//     USB keys if the loop itself stalls for 150 ms (the WebSockets library can block
//     while a frame trickles in).
//   - BOOT button = physical kill switch: release everything, output disabled until the next hello.
//
// Keys = F1 25 PS5 "Keyboard Preset 1": , / . steer, A throttle, Z brake, Space gear up,
// Left Shift gear down, F DRS, M overtake, Keypad 0 MFD, T radio.
// Keys go out as raw HID usage codes (pressRaw). Left Shift is 0xE1: in core 3.3.12
// pressRaw/releaseRaw turn 0xE0-0xE7 into modifier bits, which is what the PS5 expects.
//
// Serial log (115200): boot, Wi-Fi/IP, client connect/disconnect, hello, output_config,
// watchdog, kill switch, and one summary line per second while a tablet is connected.
// Wi-Fi credentials: copy secrets.example.h -> secrets.h.

// All code is in wheel_link_main.cpp (+ the .h files), not here: arduino-cli's automatic
// prototype generator mangles this sketch when ctags is universal-ctags (as on the dev Mac),
// and .cpp files skip that step.
