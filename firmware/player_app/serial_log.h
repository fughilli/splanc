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

  // Drain-task body: copy a chunk out under the lock, then write it to Serial with
  // NO lock held (so a stalled/disconnected serial never blocks a logging task).
  // Sleeps briefly when the ring is empty.
  //
  // A SHORT write is kept and retried, never discarded. The netstack build sets the
  // console's TX timeout to 0 (netstack_setup), so Serial.write returns short whenever
  // the HWCDC TX ring is momentarily full (a boot burst the host hasn't read yet) or
  // another task holds the console's tx lock (a direct Serial.printf) — dropping the
  // remainder lost whole boot lines and spliced others mid-line (the stable_identity
  // gate's `MAC ... (factory)` line, #353 CI). Retrying only delays THIS low-priority
  // task; a reader that never comes just leaves the ring overwriting its oldest bytes.
  void drain_once() {
    if (pend_off_ >= pend_n_) {
      pend_n_ = pend_off_ = 0;
      xSemaphoreTake(mux_, portMAX_DELAY);
      while (pend_n_ < sizeof(pend_) && tail_ != head_) {
        pend_[pend_n_++] = buf_[tail_];
        tail_ = (tail_ + 1) & kMask;
      }
      xSemaphoreGive(mux_);
      if (pend_n_ == 0) {
        vTaskDelay(pdMS_TO_TICKS(5));
        return;
      }
    }
    pend_off_ += Serial.write(pend_ + pend_off_, pend_n_ - pend_off_);
    if (pend_off_ < pend_n_) vTaskDelay(pdMS_TO_TICKS(2));  // console busy/full: retry
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
  // The chunk the drain task took out of the ring but Serial hasn't accepted yet
  // (drain task only, so no lock).
  uint8_t pend_[256];
  size_t pend_n_ = 0;
  size_t pend_off_ = 0;
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
// Static stack + TCB (never the shared heap). Static worst-case bound ~0.7 KB
// (stack_bound_test); measured ~0.6 KB.
inline bool &log_drain_running() {
  static bool running = false;
  return running;
}
inline void log_drain_start() {
  static StackType_t stack[2048 / sizeof(StackType_t)];
  static StaticTask_t tcb;
  xTaskCreateStatic(log_drain_task, "logdrain", sizeof stack, nullptr, tskIDLE_PRIORITY + 1,
                    stack, &tcb);
  log_drain_running() = true;
}

// The console for code shared with a binary that may not run the drain task (the OTA
// loader links netstack_transport.cpp but never calls log_drain_start): the ordered,
// lossless Log() ring when the drain runs, else the raw Serial console.
inline Print &Console() {
  if (log_drain_running()) return Log();
  return Serial;
}

#endif  // FIRMWARE_PLAYER_APP_SERIAL_LOG_H_
