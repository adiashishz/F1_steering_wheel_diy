/**
 * Console output for the mock.
 *
 *   log('hello', …)   → "12:03:44.120  hello     …"        one line per event
 *   statusLine(…)     → one line per second while connected
 *
 * On a terminal the status line redraws in place; piped to a file it appends.
 * Event lines wipe the status line first so the two never get mixed up.
 */

const tty = process.stdout.isTTY === true;
let statusShown = false;

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function clearStatus(): void {
  if (tty && statusShown) process.stdout.write('\r\x1b[2K');
  statusShown = false;
}

export function log(tag: string, message: string): void {
  clearStatus();
  process.stdout.write(`${stamp()}  ${tag.padEnd(9)} ${message}\n`);
}

export function statusLine(text: string): void {
  if (tty) {
    process.stdout.write(`\r\x1b[2K${stamp()}  ${text}`);
    statusShown = true;
  } else {
    process.stdout.write(`${stamp()}  ${text}\n`);
  }
}

/** Call before exiting so the prompt doesn't land on the status line. */
export function endStatus(): void {
  if (tty && statusShown) process.stdout.write('\n');
  statusShown = false;
}
