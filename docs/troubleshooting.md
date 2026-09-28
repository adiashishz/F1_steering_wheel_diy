# Troubleshooting

## Gyro works on desktop DevTools but not on the real tablet

Motion sensors (`deviceorientation`) only work on a **secure context**:
`https://…` or `http://localhost`. Opening `http://192.168.x.x:5173` on the
tablet gives no gyro data, silently.

## HTTPS page vs ESP32 WebSocket — how it's solved for now

- An HTTPS page cannot open a plain `ws://` socket (mixed content, blocked).
- Browsers reject the ESP32's self-signed certificate for `wss://`.
- But the gyro needs HTTPS (above). Serving the page from the ESP32 over plain
  HTTP would fix the socket but **not** the gyro — that's still not a secure context.

Current fix: the laptop serves the page over HTTPS (`pnpm dev:lan`, self-signed
cert) and **proxies `/esp` to the ESP32**. Page and socket are the same origin,
so there's no mixed content, and the tablet only ever trusts one certificate.

```
tablet ──https + wss /esp──► laptop (Vite) ──ws──► ESP32 wheel.local:8080
```

Cost: one extra LAN hop (~1–5 ms). The tablet's ESP32 pill shows the round trip.

### Accepting the certificate

- **Android Chrome:** open `https://<laptop-ip>:5173`, *Advanced → Proceed*. Done.
- **iPad Safari:** accepting the warning lets the page load, but Safari's
  WebSocket may still refuse the cert (pill stuck on `connecting`). Fix: trust
  the cert properly — create one with `mkcert` for the laptop's IP, AirDrop
  `rootCA.pem` to the iPad, install the profile, then enable it under
  *Settings → General → About → Certificate Trust Settings*.

## ESP32 pill says `closed` / `connecting`

- Laptop terminal shows `[esp proxy] … ECONNREFUSED / ENOTFOUND`: the board isn't
  reachable. Check the ESP32 serial log for its IP; if `wheel.local` doesn't
  resolve, use the IP: `ESP32_URL=ws://192.168.1.50:8080 pnpm dev:lan`.
- Laptop, tablet and ESP32 must be on the same Wi-Fi (2.4 GHz for the ESP32).

## Car stops steering / tablet disarms by itself mid-test

The ESP32 releases everything after 150 ms without a packet (watchdog) and the
tablet then reconnects and disarms — tap ARM again. Frequent trips mean Wi-Fi
latency spikes: move closer to the router, or check the firmware has
`WiFi.setSleep(false)` (modem sleep adds ~100 ms stalls).
