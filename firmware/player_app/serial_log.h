// Async, non-blocking serial logging.
//
// The ESP32-C6 console (USB-Serial-JTAG / HWCDC) does NOT expand '\n' to "\r\n",
// so bare-LF lines render as a staircase; and a WRITE to it BLOCKS the calling
// task when the host isn't draining the TX FIFO. Doing that blocking write from
// the LED render task froze the strip whenever serial was disconnected (the
// render task stalled inside Log(), so no new frames were produced). Making the
// write non-blocking (dropping bytes) only traded the freeze for lost logs.
//
// This logger decouples the two: `Log()` appends bytes to an in-RAM ring buffer
// — fast, lock-guarded, NEVER blocks the caller (it overwrites the oldest bytes
// when full) — and a dedicated LOW-priority drain task (log_drain_start) does the
// blocking Serial writes. So NO thread on the LED path ever blocks on serial (the
// strip can't freeze), while logs are still delivered reliably and in order
// whenever a reader is draining the port. CR/LF expansion lives here too, so
// callers write plain '\n'. Single ring, shared by every task that logs.
#ifndef FIRMWARE_PLAYER_APP_SERIAL_LOG_H_
#define FIRMWARE_PLAYER_APP_SERIAL_LOG_H_

#include <Arduino.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

// A Print that appends to a byte ring (with '\n' -> "\r\n"), drained to Serial by
// a separate task. Writes are guarded by a mutex (multiple tasks log) and never
// block: on overflow the oldest bytes are discarded so the ring holds the most
// recent output — best for a live console, and safe for the render loop.
class RingLog : public Print {
 public:
  RingLog() : mux_(xSemaphoreCreateMutex()) {}

  size_t write(uint8_t c) override {
    xSemaphoreTake(mux_, portMAX_DELAY);
    push(c);
    xSemaphoreGive(mux_);
    return 1;
  }

  size_t write(const uint8_t *buf, size_t size) override {
    // Lock once per line (Print::printf writes the whole formatted string in one
    // call), not per byte — keeps the critical section short.
    xSemaphoreTake(mux_, portMAX_DELAY);
    for (size_t i = 0; i < size; i++) push(buf[i]);
    xSemaphoreGive(mux_);
    return size;
  }

  // Drain-task body: copy a chunk out under the lock, then blocking-write it to
  // Serial with NO lock held (so a stalled/disconnected serial never blocks a
  // logging task). Sleeps briefly when the ring is empty.
  void drain_once() {
    uint8_t chunk[256];
    size_t n = 0;
    xSemaphoreTake(mux_, portMAX_DELAY);
    while (n < sizeof(chunk) && tail_ != head_) {
      chunk[n++] = buf_[tail_];
      tail_ = (tail_ + 1) & kMask;
    }
    xSemaphoreGive(mux_);
    if (n > 0) {
      Serial.write(chunk, n);
    } else {
      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }

 private:
  static constexpr size_t kCap = 8192;  // power of two
  static constexpr size_t kMask = kCap - 1;

  // Append one byte (mutex held): bare LF -> CR LF, overwrite oldest when full.
  void push(uint8_t c) {
    if (c == '\n') push_raw('\r');
    push_raw(c);
  }
  void push_raw(uint8_t c) {
    size_t next = (head_ + 1) & kMask;
    if (next == tail_) tail_ = (tail_ + 1) & kMask;  // full: drop oldest byte
    buf_[head_] = c;
    head_ = next;
  }

  uint8_t buf_[kCap];
  volatile size_t head_ = 0;  // producer index
  volatile size_t tail_ = 0;  // consumer index
  SemaphoreHandle_t mux_;
};

// Process-wide logger (constructed on first use).
inline RingLog &Log() {
  static RingLog instance;
  return instance;
}

inline void log_drain_task(void *) {
  for (;;) Log().drain_once();
}

// Start the low-priority drain task. Call once, early in setup() (after
// Serial.begin). Priority sits BELOW the render (10) and transmit (11) tasks and
// the Arduino loop (1) so draining never delays LED output; it runs in the idle
// gaps, which is ample for the byte rates we log.
inline void log_drain_start() {
  xTaskCreate(log_drain_task, "logdrain", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

#endif  // FIRMWARE_PLAYER_APP_SERIAL_LOG_H_
