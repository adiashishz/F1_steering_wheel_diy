import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `--host` on the CLI flips this on for LAN testing (Phase 12).
    host: false,
  },
  // @wheel/protocol is shipped as raw TypeScript. Vite must not try to
  // pre-bundle it as a normal dependency, or edits there won't hot-reload.
  optimizeDeps: {
    exclude: ['@wheel/protocol'],
  },
});
