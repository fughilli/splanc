// The C side of lh_p4.rs (see there): the tracker's device + kernel behind a C ABI, every
// call from the tracker task. The structs mirror its #[repr(C)] ones field for field.
#pragma once

#include <stddef.h>
#include <stdint.h>

extern "C" {

struct LhStatus {
  uint8_t configured, tracking, stations, clock_ok, streaming;
  uint32_t imu, pulses, poses;
  uint32_t sweeps, sweep_parts, late_pulses;  // sweeps, the parts they went out in, late pulses
  uint32_t light_margin_us;                   // how late light reports recently came
  double t;           // device time of the pose (s)
  float pos[3];       // head in the world (m, z up)
  float quat[4];      // its orientation (w, x, y, z)
  float vel[3];       // head velocity (m/s, world)
  float accel[3];     // head acceleration, gravity removed (m/s², world)
  float omega[3];     // angular rate (rad/s, world)
  int64_t pose_us;    // P4 clock (esp_timer µs): the pose's time
  int64_t light_us;   //   its newest light hit
  int64_t trigger_us; //   arrival of the report / clock tick that completed its sweep
  int64_t ready_us;   //   the kernel done with it
  float pos_sigma;    // the pose's position uncertainty (m, sqrt of the covariance trace)
  uint32_t starts, losses, coasts;  // locks gained (fresh solves) and lost; darks coasted
  // lh_health::Health (#446): 0 lost, 1 uncertain (σ past the limit), 2 acquiring (a fresh
  // solve settling), 3 coasting (IMU dead reckoning, no light confirming it, σ within the
  // limit), 4 locked. Coasting and locked are poses to follow.
  uint8_t health;
  uint8_t speculative;  // the newest pose is the kernel's dead reckoning
};

enum LhHealth : uint8_t { LH_LOST = 0, LH_UNCERTAIN = 1, LH_ACQUIRING = 2, LH_COASTING = 3, LH_LOCKED = 4 };

// CPU cycles by kind of work (0 decode, 1 IMU, 2 light/clock without a pose, 3 with one)
// and how late light reports came over the fastest delivery, since the last call.
struct LhProfile {
  uint32_t n[4];
  uint64_t cycles[4];
  uint32_t max_cycles[4];
  uint32_t light_reports;
  uint64_t light_late_sum_us;
  uint32_t light_late_max_us;
};

int lh_attach(uint16_t vid, uint16_t pid);
int lh_handshake();
void lh_detach();
// One HID input report, `us` its arrival (esp_timer_get_time()).
void lh_report(int interface, const uint8_t* data, size_t len, int64_t us);
// The P4's clock now (esp_timer µs): the kernel takes the hits that came in (or a
// finished sweep, not streaming) right away.
void lh_clock(int64_t us);
void lh_status(LhStatus* out);
void lh_profile(LhProfile* out);
// Stream sweeps into the filter as their reports come (1, the default) or whole (0).
void lh_set_stream(int on);
int lh_station_prior(uint32_t id, const float* p);

}  // extern "C"
