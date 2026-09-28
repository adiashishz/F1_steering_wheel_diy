import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Two ways to run:
 *   pnpm dev       http://localhost:5173           desktop, simulated gyro
 *   pnpm dev:lan   https://<laptop-ip>:5173 on the LAN, self-signed cert — the tablet's gyro
 *                  needs a secure context, so the tablet must use https.
 *
 * Either way the page talks to `/esp` on its own origin, and Vite forwards that
 * WebSocket to the ESP32. Same origin → no mixed-content block on https, and the
 * tablet never needs to know the board's address.
 *
 *   ESP32_URL=ws://wheel.local:8080 pnpm dev:lan   → the real board (mDNS name from wheel_link)
 *   (unset)                                       → the mock server on ws://localhost:8080
 */
const espTarget = process.env.ESP32_URL ?? 'ws://localhost:8080';

export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  return {
    plugins: lan ? [react(), basicSsl()] : [react()],
    server: {
      port: 5173,
      host: lan,
      proxy: {
        '/esp': {
          target: espTarget,
          ws: true,
          rewrite: () => '/',
          configure: (proxy) => {
            // A board that's off or rebooting is normal; one line, not a stack trace.
            proxy.on('error', (err) => console.warn(`[esp proxy] ${espTarget}: ${err.message}`));
          },
        },
      },
    },
    // @wheel/protocol is shipped as raw TypeScript. Vite must not try to
    // pre-bundle it as a normal dependency, or edits there won't hot-reload.
    optimizeDeps: {
      exclude: ['@wheel/protocol'],
    },
  };
});
