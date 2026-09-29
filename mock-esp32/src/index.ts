/**
 * mock-esp32 — stands in for the real ESP32 so the tablet can be built and
 * tested without hardware. Speaks protocol/controller-state.md exactly.
 *
 *   tablet ──ws://<host>:8080 (any path)──► Device (session.ts) ──► key events (console)
 *          ◄── hello_ack · pong · status ──┘
 *   curl http://<host>:8080/status          current session as JSON
 *
 * Timers, like the firmware's loop():
 *   1 ms   key machine tick + watchdog      (pulses are timed here, not on the tablet)
 *   200 ms status to the tablet              (~5 Hz)
 *   1 s    one console status line while connected
 *
 * Usage: pnpm -F mock-esp32 dev [-- --port=8080] [--keys]     (or env PORT)
 *
 * BRIDGE MODE — the real thing, not a mock:
 *   --serial[=/dev/cu.usbmodem…]   drive the ESP32 `pad_bridge` firmware (a fake DualSense on this
 *                                  Mac's USB) → PS Remote Play → PS5. Default port: auto-detect.
 *   --steer=left|right             which stick steers (default left)
 *   --map=gearUp:cross,drs:r1      action → DualSense button overrides
 */

import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { PROTOCOL_VERSION } from '@wheel/protocol';
import { WebSocketServer } from 'ws';
import { endStatus, log, statusLine } from './log';
import { PadBridge, parseMapping } from './padBridge';
import { Device, SERVER_INFO, WATCHDOG_MS } from './session';

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='))?.slice('--port='.length);
const port = Number(portArg ?? process.env.PORT ?? 8080);
const printKeys = args.includes('--keys');

const serialArg = args.find((a) => a === '--serial' || a.startsWith('--serial='));
const valueOf = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const device = new Device(printKeys);
const pad = serialArg
  ? new PadBridge(serialArg.includes('=') ? serialArg.slice('--serial='.length) : 'auto', parseMapping(valueOf('map'), valueOf('steer')))
  : null;
if (pad) {
  SERVER_INFO.name = 'mac-pad-bridge';
  device.padStatus = () => ({ keys: pad.held(), steer: device.output().steering });
}

// ─── HTTP (/status) + WebSocket on the same port ────────────────────────────

const http = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.split('?')[0] === '/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(device.info(performance.now()), null, 2));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('mock-esp32: connect with a WebSocket, or GET /status\n');
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  const who = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log('connect', `${who} ${req.url ?? '/'}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // text frames only
    device.handle(ws, data.toString(), performance.now());
  });
  ws.on('close', (code) => {
    log('close', `${who} (code ${code})`);
    device.onClose(ws, performance.now());
  });
  ws.on('error', (err) => log('error', `${who} socket: ${err.message}`));
});

// ws re-emits the http server's errors (e.g. EADDRINUSE); one handler covers both.
wss.on('error', (err) => {
  log('error', err.message);
  process.exit(1);
});

http.listen(port, () => {
  log(
    'start',
    `${SERVER_INFO.name} ${SERVER_INFO.version} · protocol v${PROTOCOL_VERSION} · ws://0.0.0.0:${port} · watchdog ${WATCHDOG_MS} ms${printKeys ? ' · printing keys' : ''}`,
  );
});

// ─── timers ─────────────────────────────────────────────────────────────────

const tickTimer = setInterval(() => {
  const now = performance.now();
  device.tick(now);
  pad?.update(device.output(), now);
}, 1);
const statusTimer = setInterval(() => device.sendStatus(performance.now()), 200);
const consoleTimer = setInterval(() => {
  pad?.tickSecond();
  const padInfo = pad ? ` · pad ${pad.connected ? `${pad.linesPerSec} lines/s L2 ${pad.pad.l2} R2 ${pad.pad.r2} X ${pad.pad.lx}` : 'NOT CONNECTED'}` : '';
  if (device.connected) statusLine(device.summary(performance.now()) + padInfo);
}, 1000);

// ─── shutdown: release everything first ─────────────────────────────────────

function shutdown(): void {
  device.machine.releaseAll(performance.now());
  pad?.centreAndClose();
  clearInterval(tickTimer);
  clearInterval(statusTimer);
  clearInterval(consoleTimer);
  endStatus();
  log('stop', 'all keys released');
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close();
  http.close();
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
