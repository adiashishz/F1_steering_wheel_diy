/**
 * @wheel/protocol — the shared layer.
 *
 * Everything in here runs in THREE places:
 *   1. the tablet (browser)
 *   2. the mock ESP32 (node)
 *   3. eventually the real ESP32 firmware (hand-ported to C++)
 *
 * So: no browser APIs, no node APIs, no dependencies. Pure TypeScript only.
 */

export * from './version';
export * from './controllerState';
export * from './messages';
export * from './codec';
export * from './math';
export * from './axis';
export * from './pedals';
export * from './keymap';
