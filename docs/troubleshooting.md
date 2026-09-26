# Troubleshooting

## Gyro works on desktop DevTools but not on the real tablet

Motion sensors (`deviceorientation`) only work on a **secure context**:
`https://…` or `http://localhost`. Opening `http://192.168.x.x:5173` on the
tablet gives no gyro data, silently.

## Known conflict: HTTPS page vs ESP32 WebSocket

- An HTTPS page cannot open a plain `ws://` socket (mixed content, blocked).
- Browsers reject the ESP32's self-signed certificate for `wss://`.
- But the gyro needs HTTPS (above).

Likely fix, solved in Phase 12: **serve the built app from the ESP32 itself**,
so page and socket are the same origin. Until then, develop on
`http://localhost` in a desktop browser, where both work.
