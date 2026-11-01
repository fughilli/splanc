// ESP32-P4 tracker bring-up: a Vive Tracker 3.0 wired to the P4's USB OTG port,
// tracked on the P4 by lh_kernel (fughilli/lighthouse). Prints what happens and,
// once a second, the report/pose rates and the latest pose on the IDF console
// (UART0 + the USB-Serial-JTAG port).
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <stdio.h>

#include "firmware/p4/tracker/lh_p4.h"
#include "firmware/p4/tracker/usb_tracker.h"

#ifdef LH_DUMP
#include <driver/uart.h>
static constexpr const char* kLogPrefix = "# ";
#else
static constexpr const char* kLogPrefix = "";
#endif

static QueueHandle_t g_reports;
// Bring-up: where the tracker task is, for the lock-free heartbeat.
static volatile int g_stage = 0;
static volatile uint32_t g_loops = 0, g_reports_in = 0;
// The longest lh_report call (us) since the last heartbeat, and the one in progress.
static volatile int64_t g_report_max_us = 0, g_report_start_us = 0;
#include <esp_rom_sys.h>

static void tracker_task(void*) {
  uint16_t vid = 0, pid = 0;
  bool open = false, configured = false;
  TickType_t last_print = xTaskGetTickCount();
  LhStatus prev = {};
  while (true) {
    g_loops++;
    g_stage = 1;
    if (!open && tracker_usb_open(&vid, &pid)) {
      open = true;
      configured = false;
      if (lh_attach(vid, pid) == 1) tracker_usb_stream();
    }
    if (open && tracker_usb_gone()) {
      printf("usb: device gone\n");
      lh_detach();
      tracker_usb_close();
      open = configured = false;
    }
    if (open && !configured) {
      // A wired tracker answers the config read right away; retry if not.
      configured = lh_handshake() == 0;
      if (!configured) vTaskDelay(pdMS_TO_TICKS(500));
    }
    TrackerReport r;
    // Wait up to 5 ms for the first report, then take only what is queued: the
    // tracker sends one every ~1.5 ms, so waiting on each would never end.
    for (TickType_t wait = pdMS_TO_TICKS(5); xQueueReceive(g_reports, &r, wait) == pdTRUE; wait = 0) {
      g_stage = 2;
      g_reports_in++;
#ifdef LH_DUMP
      tracker_dump_report(r);
#endif
      g_report_start_us = esp_timer_get_time();
      lh_report(r.iface, r.data, r.len, r.us);
      {
        const int64_t d = esp_timer_get_time() - g_report_start_us;
        if (d > g_report_max_us) g_report_max_us = d;
        g_report_start_us = 0;
      }
      g_stage = 3;
    }
    const TickType_t now = xTaskGetTickCount();
    if (now - last_print >= pdMS_TO_TICKS(1000)) {
      const float dt = (now - last_print) / (float)configTICK_RATE_HZ;
      last_print = now;
      LhStatus s;
      g_stage = 4;
      lh_status(&s);
      g_stage = 5;
      printf("%slh: %s%s, %u stations; IMU %.0f/s, light %.0f/s, poses %.0f/s; pos (%.4f, %.4f, %.4f) "
             "q (%.4f, %.4f, %.4f, %.4f); queue %u\n",
             kLogPrefix, s.configured ? "configured" : "not configured", s.tracking ? ", tracking" : "", s.stations,
             (s.imu - prev.imu) / dt, (s.pulses - prev.pulses) / dt, (s.poses - prev.poses) / dt, s.pos[0], s.pos[1],
             s.pos[2], s.quat[0], s.quat[1], s.quat[2], s.quat[3], (unsigned)uxQueueMessagesWaiting(g_reports));
      prev = s;
#ifndef LH_DUMP
      if (!open) tracker_usb_debug();
#endif
    }
  }
}

static void heartbeat_task(void*);

void setup() {
  delay(300);
  printf("p4 tracker: waiting for a Vive device on the USB OTG port\n");
#ifdef LH_DUMP
  // A report stream is ~100 kB/s of hex: more than 115200 baud carries.
  printf("p4 tracker: raw dump at 2000000 baud\n");
  fflush(stdout);
  delay(20);
  uart_set_baudrate(UART_NUM_0, 2000000);
#endif
  g_reports = xQueueCreate(1024, sizeof(TrackerReport));
  tracker_usb_start(g_reports, 5);
  // The kernel's EKF and calibration run here; give it the second core and a big stack.
  xTaskCreatePinnedToCore(tracker_task, "tracker", 32 * 1024, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(heartbeat_task, "hb", 4096, nullptr, 2, nullptr, 0);
}

// Bring-up heartbeat on core 0: the tracker task and Arduino's loop() share core 1.
static void heartbeat_task(void*) {
  while (true) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    const int64_t start = g_report_start_us;
    esp_rom_printf("%shb: stage %d loops %u reports %u queue %u; lh_report max %u us, current %u us; psram %u\n",
                   kLogPrefix, g_stage, (unsigned)g_loops, (unsigned)g_reports_in,
                   (unsigned)uxQueueMessagesWaiting(g_reports), (unsigned)g_report_max_us,
                   (unsigned)(start ? esp_timer_get_time() - start : 0),
                   (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    g_report_max_us = 0;
  }
}

void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }
