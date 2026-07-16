// Serial logging with newline translation.
//
// The ESP32-C6 console (USB-Serial-JTAG or a raw UART) does NOT expand '\n'
// to "\r\n" on the way out, so log lines that end in a bare '\n' render as a
// staircase on a plain terminal. Rather than sprinkle '\r' through the
// application code, funnel all logging through this one Print wrapper, which
// inserts the '\r'. Callers write plain '\n'; the CR/LF convention lives here.
//
// Usage: `Log().printf("...\n", ...)` / `Log().println("...")`. Serial.begin()
// must have run first (Log() wraps the global Serial).
#ifndef FIRMWARE_PLAYER_APP_SERIAL_LOG_H_
#define FIRMWARE_PLAYER_APP_SERIAL_LOG_H_

#include <Arduino.h>

// A Print that forwards to an inner Print, expanding '\n' -> "\r\n".
class LineEndingPrint : public Print {
 public:
  explicit LineEndingPrint(Print &inner) : inner_(inner) {}

  size_t write(uint8_t c) override {
    size_t n = 0;
    if (c == '\n') n += inner_.write('\r');  // bare LF -> CR LF
    return n + inner_.write(c);
  }

  size_t write(const uint8_t *buffer, size_t size) override {
    size_t n = 0;
    for (size_t i = 0; i < size; i++) n += write(buffer[i]);
    return n;
  }

 private:
  Print &inner_;
};

// Process-wide logger over the global Serial (constructed on first use).
inline LineEndingPrint &Log() {
  static LineEndingPrint instance(Serial);
  return instance;
}

#endif  // FIRMWARE_PLAYER_APP_SERIAL_LOG_H_
