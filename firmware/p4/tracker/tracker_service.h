// The wired Vive tracker as a service inside the P4 player (docs/design/p4-c6-split.md;
// the tracker is an addition to it): a task on the P4 that runs the USB host,
// lh_device and lh_kernel (lh_p4.rs) and keeps the latest pose for the player, whose
// render task reads it at the start of every frame (tracker_module.cpp: predicted to when
// that frame lights).
#pragma once

#include <stdint.h>

#include "firmware/p4/tracker/lh_p4.h"

struct TrackerPose {
  uint32_t seq;        // bumps on every new pose (0 = none yet)
  bool configured;     // a tracker is attached and configured
  bool tracking;       // the kernel is tracking it
  bool clock_ok;       // the tracker's clock is mapped onto the P4's: the *_us are valid
  uint8_t stations;    // calibrated base stations
  float t;             // device time of the pose (s)
  float pos[3];        // tracker head in the lighthouse world (m, z up)
  float quat[4];       // its orientation (w, x, y, z)
  float vel[3];        // at the pose (world): head velocity (m/s),
  float accel[3];      //   acceleration without gravity (m/s²),
  float omega[3];      //   angular rate (rad/s)
  // P4 clock (esp_timer µs): the pose's time, its newest light hit, the arrival of what
  // completed its sweep, the kernel done with it, and this snapshot published.
  int64_t pose_us, light_us, trigger_us, ready_us, published_us;
  uint32_t poses, imu, pulses;  // running counts
  uint32_t sweeps, sweep_parts, late_pulses;
  uint32_t light_margin_us;  // how late light reports recently came over the fastest
  bool streaming;            // the kernel streams sweeps (tracker_service_stream)
  // How far the pose can be trusted (lh_health, #446): LH_LOCKED light confirms it;
  // LH_COASTING the IMU's dead reckoning since the light was lost, still within the σ
  // limit (usable, flagged); LH_ACQUIRING a fresh solve settling; LH_UNCERTAIN σ past the
  // limit; LH_LOST nothing (the matrices hold the last pose).
  uint8_t health;
  bool speculative;               // the newest pose is dead reckoning
  float pos_sigma;                // position uncertainty of the pose (m)
  uint32_t starts, losses, coasts;  // locks gained (fresh solves) and lost; darks coasted
};

// Starts the USB host (its tasks at `usb_prio`, core 0) and the tracker task, pinned to
// `core`: at `prio` while not tracking (a pose bootstrap there takes ~0.6 s and must not
// starve anything), at `tracking_prio` while tracking (a report's work is tens of µs and
// its light should reach the filter at once).
void tracker_service_start(int prio, int tracking_prio, int usb_prio, int core);
// A consistent copy of the latest state; never blocks the tracker task for long.
void tracker_service_get(TrackerPose* out);
// How far behind the tracker task is: the age of the last report the kernel took, the
// worst age and queue depth since the previous call (which resets them), the reports
// dropped so far to a full queue, and those skipped as a stale backlog.
struct TrackerLag {
  uint32_t last_us, max_us, depth_max, dropped, skipped;  // skipped: stale backlog dropped
};
void tracker_service_lag(TrackerLag* out);
// Where the tracker task's time went since the previous call (lh_p4.h), which resets it.
void tracker_service_profile(LhProfile* out);
// Stream sweeps into the filter as their reports come (the default), or whole (any task;
// the tracker task applies it).
void tracker_service_stream(bool on);
// Adopt a base station's pose from lhd (any task): queued for the tracker task, which
// hands it to the kernel (lh_station_prior). `p` = x, y, z, qw, qx, qy, qz.
void tracker_service_adopt(uint32_t id, const float p[7]);
