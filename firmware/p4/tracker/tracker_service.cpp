// See tracker_service.h. The task loop is the bring-up image's (tracker.cpp) without
// its console prints: attach, handshake, then feed every report to lh_report.
#include "firmware/p4/tracker/tracker_service.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <esp_timer.h>
#include <freertos/task.h>
#include <string.h>

#include "firmware/p4/tracker/lh_p4.h"
#include "firmware/p4/tracker/usb_tracker.h"

namespace {

QueueHandle_t g_reports;
struct Adopt {
  uint32_t id;
  float p[7];
};
QueueHandle_t g_adopt;
portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
TrackerPose g_pose = {};
// How far behind the tracker task runs: a report's age when the kernel gets it.
uint32_t g_lag_us = 0, g_lag_max_us = 0, g_depth_max = 0, g_skipped = 0;
// A backlog beyond this many reports (~1 ms each) is stale: the oldest are dropped
// down to kBacklogKeep, so the kernel tracks now rather than seconds ago.
constexpr UBaseType_t kBacklogMax = 48, kBacklogKeep = 8;
// The profile, taken from lh_profile once a second on this task and summed here until
// tracker_service_profile collects it.
LhProfile g_profile = {};
// tracker_service_stream's request (-1 none), applied on this task.
volatile int g_stream_req = -1;

void publish(const LhStatus& s) {
  TrackerPose p;
  p.configured = s.configured;
  p.tracking = s.tracking;
  p.clock_ok = s.clock_ok;
  p.stations = s.stations;
  p.t = (float)s.t;
  memcpy(p.pos, s.pos, sizeof p.pos);
  memcpy(p.quat, s.quat, sizeof p.quat);
  memcpy(p.vel, s.vel, sizeof p.vel);
  memcpy(p.accel, s.accel, sizeof p.accel);
  memcpy(p.omega, s.omega, sizeof p.omega);
  p.pose_us = s.pose_us;
  p.light_us = s.light_us;
  p.trigger_us = s.trigger_us;
  p.ready_us = s.ready_us;
  p.poses = s.poses;
  p.imu = s.imu;
  p.pulses = s.pulses;
  p.sweeps = s.sweeps;
  p.sweep_parts = s.sweep_parts;
  p.late_pulses = s.late_pulses;
  p.light_margin_us = s.light_margin_us;
  p.streaming = s.streaming;
  p.health = s.health;
  p.pos_sigma = s.pos_sigma;
  p.starts = s.starts;
  p.losses = s.losses;
  p.coasts = s.coasts;
  p.speculative = s.speculative;
  taskENTER_CRITICAL(&g_mux);
  const bool fresh = s.poses != g_pose.poses;
  p.seq = g_pose.seq + (fresh ? 1 : 0);
  p.published_us = fresh ? esp_timer_get_time() : g_pose.published_us;
  g_pose = p;
  taskEXIT_CRITICAL(&g_mux);
}

void take_profile() {
  LhProfile p;
  lh_profile(&p);
  taskENTER_CRITICAL(&g_mux);
  for (int k = 0; k < 4; k++) {
    g_profile.n[k] += p.n[k];
    g_profile.cycles[k] += p.cycles[k];
    if (p.max_cycles[k] > g_profile.max_cycles[k]) g_profile.max_cycles[k] = p.max_cycles[k];
  }
  g_profile.light_reports += p.light_reports;
  g_profile.light_late_sum_us += p.light_late_sum_us;
  if (p.light_late_max_us > g_profile.light_late_max_us) g_profile.light_late_max_us = p.light_late_max_us;
  taskEXIT_CRITICAL(&g_mux);
}

int g_prio = 0, g_tracking_prio = 0;

void task(void*) {
  uint16_t vid = 0, pid = 0;
  bool high = false;
  bool open = false, configured = false;
  while (true) {
    if (!open && tracker_usb_open(&vid, &pid)) {
      open = true;
      configured = false;
      if (lh_attach(vid, pid) == 1) tracker_usb_stream();
    }
    if (open && tracker_usb_gone()) {
      lh_detach();
      tracker_usb_close();
      open = configured = false;
    }
    if (open && !configured) {
      configured = lh_handshake() == 0;
      if (!configured) vTaskDelay(pdMS_TO_TICKS(500));
    }
    Adopt a;
    while (configured && xQueueReceive(g_adopt, &a, 0) == pdTRUE) lh_station_prior(a.id, a.p);
    if (g_stream_req >= 0) {
      lh_set_stream(g_stream_req);
      g_stream_req = -1;
    }
    TrackerReport r;
    // Wait for the first report, then take only what is queued (one arrives every ~1 ms),
    // at most a batch: publish between batches, or a backlog (after anything slow on this
    // task) is worked off with no pose out until the queue is empty.
    if (uxQueueMessagesWaiting(g_reports) > kBacklogMax) {
      uint32_t k = 0;
      while (uxQueueMessagesWaiting(g_reports) > kBacklogKeep && xQueueReceive(g_reports, &r, 0) == pdTRUE) k++;
      taskENTER_CRITICAL(&g_mux);
      g_skipped += k;
      taskEXIT_CRITICAL(&g_mux);
    }
    bool any = false;
    int n = 0;
    // Wait at most a tick (1 ms) for the first: between reports the kernel still gets the
    // clock (lh_clock below), which sends a sweep as soon as the laser has passed.
    for (TickType_t wait = 1; n < 16 && xQueueReceive(g_reports, &r, wait) == pdTRUE; wait = 0) {
      const uint32_t depth = uxQueueMessagesWaiting(g_reports);
      const uint32_t lag = (uint32_t)(esp_timer_get_time() - r.us);
      taskENTER_CRITICAL(&g_mux);
      g_lag_us = lag;
      if (lag > g_lag_max_us) g_lag_max_us = lag;
      if (depth > g_depth_max) g_depth_max = depth;
      taskEXIT_CRITICAL(&g_mux);
      lh_report(r.iface, r.data, r.len, r.us);
      any = true;
      n++;
    }
    if (configured) lh_clock(esp_timer_get_time());
    if (configured || any || !open) {
      LhStatus s;
      lh_status(&s);
      publish(s);
      // Above render while tracking; back down as soon as it isn't (the next sweep may
      // start a bootstrap).
      if ((s.tracking != 0) != high) {
        high = s.tracking != 0;
        vTaskPrioritySet(nullptr, high ? g_tracking_prio : g_prio);
      }
    }
    static int64_t last_profile_us = 0;
    const int64_t now = esp_timer_get_time();
    if (now - last_profile_us >= 1000000) {
      last_profile_us = now;
      take_profile();
    }
  }
}

}  // namespace

void tracker_service_start(int prio, int tracking_prio, int usb_prio, int core) {
  g_prio = prio;
  g_tracking_prio = tracking_prio;
  g_reports = xQueueCreate(1024, sizeof(TrackerReport));
  g_adopt = xQueueCreate(8, sizeof(Adopt));
  tracker_usb_start(g_reports, usb_prio);
  // The kernel's EKF and calibration run on this task: a big stack.
  xTaskCreatePinnedToCore(task, "tracker", 32 * 1024, nullptr, prio, nullptr, core);
}

void tracker_service_get(TrackerPose* out) {
  taskENTER_CRITICAL(&g_mux);
  *out = g_pose;
  taskEXIT_CRITICAL(&g_mux);
}

void tracker_service_lag(TrackerLag* out) {
  taskENTER_CRITICAL(&g_mux);
  out->last_us = g_lag_us;
  out->max_us = g_lag_max_us;
  out->depth_max = g_depth_max;
  out->skipped = g_skipped;
  g_lag_max_us = g_depth_max = 0;
  taskEXIT_CRITICAL(&g_mux);
  out->dropped = tracker_usb_dropped();
}

void tracker_service_profile(LhProfile* out) {
  taskENTER_CRITICAL(&g_mux);
  *out = g_profile;
  g_profile = {};
  taskEXIT_CRITICAL(&g_mux);
}

void tracker_service_stream(bool on) { g_stream_req = on ? 1 : 0; }

void tracker_service_adopt(uint32_t id, const float p[7]) {
  if (!g_adopt) return;
  Adopt a = {id, {}};
  memcpy(a.p, p, sizeof a.p);
  xQueueSend(g_adopt, &a, 0);  // full (a burst): lhd sends again in a second
}
