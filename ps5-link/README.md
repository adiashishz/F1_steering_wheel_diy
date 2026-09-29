# ps5-link

Headless PS5 Remote Play client that **only sends controller input**, built on
[chiaki-ng](../third_party/chiaki-ng)'s `libchiaki` (git submodule).
Audio and video are disabled — chiaki drops those packets on arrival — so there's
no window and no decoding. You watch the game on the TV.

```
tablet ──Wi-Fi──► Mac bridge (mock-esp32 --ps5) ──stdin "P …"──► ps5-link ──Remote Play──► PS5 ──HDMI──► TV
```

No ESP32 needed. The line format is the same one the ESP32 `pad_bridge` takes, so the
bridge's mapping (`padBridge.ts`) is shared by both routes.

## Build (once)

```bash
git submodule update --init --recursive
CC=clang CXX=clang++ cmake -S ps5-link -B ps5-link/build -DCMAKE_BUILD_TYPE=Release \
  -DOPENSSL_ROOT_DIR=$(brew --prefix openssl@3)
cmake --build ps5-link/build --target ps5-link -j 8
```

Needs Homebrew `openssl@3` and `libevent`, plus Python `grpcio-tools` (nanopb's protoc
wrapper — no system `protoc`). json-c, miniupnpc and curl are built from source.

## Pair with the PS5 (once)

1. **PSN account ID** (base64): `python3 third_party/chiaki-ng/scripts/psn-account-id.py`
   — log in to PSN in the browser it opens, paste the redirect URL back.
2. **PIN**: PS5 → Settings → System → Remote Play → **Link Device** (valid a few minutes).
3. ```bash
   ps5-link/build/ps5-link register --host <ps5-ip> --pin <8 digits> \
     --account-id <base64> --creds ps5-link/ps5-link.creds
   ```
   `ps5-link.creds` is git-ignored — keep it private.

## Drive

```bash
pnpm dev:ps5        # tablet page + bridge in --ps5 mode (starts ps5-link, restarts it if it drops)
```

Close Sony's PS Remote Play app first — the PS5 allows one Remote Play session.
`ps5-link run --wake` wakes the PS5 from rest mode first.

Input is sent on change only — a line holds until the next one, and nothing is
ever repeated to the PS5 (it takes repeated input as new presses). Stdin closed
(bridge died) → idle and disconnect.
