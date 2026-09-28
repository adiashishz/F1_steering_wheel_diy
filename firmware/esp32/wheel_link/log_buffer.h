// Non-blocking serial log.
//
// The USB CDC TX buffer is only 64 bytes, so a plain Serial.printf of a 120-char line
// blocks the loop for a few ms while the host drains it — long enough to smear a 4 ms
// steering pulse. Instead, logf() formats into a RAM ring and drainLog() (called every
// loop) writes only as much as fits right now. Full ring → oldest text is dropped.
// No monitor attached → availableForWrite() is 0 and text just ages out of the ring.

#pragma once

#include <Arduino.h>
#include <stdarg.h>

constexpr size_t LOG_RING_SIZE = 4096;

static char logRing[LOG_RING_SIZE];
static size_t logHead = 0;  // next write position
static size_t logLen = 0;   // bytes waiting

inline void logPut(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    logRing[logHead] = s[i];
    logHead = (logHead + 1) % LOG_RING_SIZE;
    if (logLen < LOG_RING_SIZE) logLen++;  // else: overwrote the oldest byte
  }
}

/** printf into the log, prefixed with millis() like the other sketches. Adds no newline. */
inline void logf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
inline void logf(const char *fmt, ...) {
  char buf[256];
  int n = snprintf(buf, sizeof buf, "%8lu  ", (unsigned long)millis());
  va_list ap;
  va_start(ap, fmt);
  int m = vsnprintf(buf + n, sizeof buf - n, fmt, ap);
  va_end(ap);
  if (m < 0) return;
  size_t total = n + ((size_t)m < sizeof buf - n ? (size_t)m : sizeof buf - n - 1);
  logPut(buf, total);
}

/** Write whatever fits in the USB TX buffer right now. Never waits. */
inline void drainLog() {
  if (logLen == 0) return;
  int room = Serial.availableForWrite();
  if (room <= 0) return;
  size_t tail = (logHead + LOG_RING_SIZE - logLen) % LOG_RING_SIZE;
  size_t n = logLen < (size_t)room ? logLen : (size_t)room;
  size_t first = n < LOG_RING_SIZE - tail ? n : LOG_RING_SIZE - tail;  // up to the wrap point
  size_t sent = Serial.write((const uint8_t *)logRing + tail, first);
  logLen -= sent;
}
