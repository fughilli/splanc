// A Vive tracker on the ESP32-P4's high-speed USB OTG port (usb_tracker.cpp).
#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <stddef.h>
#include <stdint.h>

// One interrupt-IN report from HID interface `iface`.
struct TrackerReport {
  int64_t us;  // esp_timer time it arrived
  uint8_t iface;
  uint8_t len;
  uint8_t data[64];
};

// Installs the USB host and starts its tasks (priority `prio`, core 0); reports go to
// `reports` (a queue of TrackerReport), stamped when their transfer completes.
void tracker_usb_start(QueueHandle_t reports, int prio);
// Opens a newly attached device and claims its HID interfaces. True when a
// device was opened (vid/pid filled in).
bool tracker_usb_open(uint16_t* vid, uint16_t* pid);
// Starts the interrupt-IN streams on the claimed interfaces.
void tracker_usb_stream();
// The device was unplugged.
bool tracker_usb_gone();
// Reports dropped so far because the queue was full (the tracker task fell behind).
uint32_t tracker_usb_dropped();
// Prints the root port state (bring-up).
void tracker_usb_debug();
void tracker_usb_close();

// For lh_p4.rs (see there): HID feature reports on interface 0, the report id
// first. A negative result is a NAK / failure (-2: no device).
extern "C" int p4_tracker_get_feature(uint8_t report_id, uint8_t* buf, size_t len);
extern "C" int p4_tracker_set_feature(const uint8_t* data, size_t len);
extern "C" void p4_delay_ms(uint32_t ms);
extern "C" void p4_log(const uint8_t* msg, size_t len);
extern "C" int64_t p4_now_us();   // esp_timer_get_time()
extern "C" uint32_t p4_cycles();  // the CPU cycle counter (profiling)

// Every feature exchange since the device was opened (the handshake: config and
// calibration reads), kept for a recording started later (tracker_service_record).
struct TrackerFeature {
  int64_t us;
  int16_t rtn;
  uint8_t set;  // 0 GET, 1 SET
  uint8_t len;
  uint8_t data[72];
};
size_t tracker_feature_count();
const TrackerFeature* tracker_feature(size_t i);

// LH_DUMP builds (esp32p4_tracker_dump): every feature exchange and input
// report as a console line, for tools/p4_dump_to_rec.py.
//   F <GET|SET> <us> <rtn> <hex>
//   R <iface> <us> <hex>
// Everything else printed in a dump build starts with '#'.
void tracker_dump_feature(const char* kind, int rtn, const uint8_t* data, size_t len);
void tracker_dump_report(const TrackerReport& r);
