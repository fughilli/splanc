// The wired Vive tracker as a player module (player_module.h): everything the tracker
// adds to a player image lives here and in tracker_service / usb_tracker / lh_p4, and
// linking :tracker_module is all it takes to have it.
//
// Uniform pool (all mat4 column-major, GLSL conventions, metres; "world" is the lighthouse
// world, lhd's once the P4 has adopted its stations), published by the render task at the
// start of every effect frame (the frame() hook), predicted to when that frame lights:
//   tracker     world <- tracker head (the live pose, predicted)
//   mount       tracker <- fixture map frame (T_TF, from the calibration; kept in NVS)
//   pose        world <- fixture map frame = tracker * mount
//               (the convention of agent/skill/examples/plane_slice_pose.fx)
//   tracker_ok     1 while the pose is one to follow: locked, or coasting (dead reckoned
//                  on the IMU through an occlusion or fast motion, its σ within
//                  POS_SIGMA_LIMIT_M = 2 cm, at most COAST_MAX_S = 1 s; lh_health.rs).
//                  0 when lost, uncertain or a fresh solve still settling: the matrices
//                  then hold their last value (no prediction), so an effect should fade or
//                  freeze rather than follow them.
//   tracker_state  which (lh_health, #446): 0 lost, 1 uncertain, 2 acquiring, 3 coasting,
//                  4 locked; an effect that wants optical locks only checks for 4
//
// OSC (udp/9000, forwarded to the P4 by its C6 front end), claimed before the mailbox:
//   /lh/station ,iffffff f  base station id, then world <- station (x y z qw qx qy qz):
//                          the kernel adopts lhd's station poses, so both share one world
//   /lh/fixture ,f x16     world <- fixture map (from the stylus calibration on the host,
//                          the fixture held still): mount = tracker^-1 * fixture, saved
//   /lh/mount   ,f x16     tracker <- fixture map, set directly, saved
//   /lh/unmount ,          forget the mount
//   /lh/predict ,f         1 (default): predict the pose to when the frame lights; 0: the
//                          newest pose as it is (to compare)
//   /lh/lead    ,f         ms added to the prediction (default 0): the tracker's own delay
//                          before its fastest report, which the P4 can't measure
//   /lh/stream  ,f         1 (default): sweep hits into the filter as their report comes in
//                          (~5 ms sooner; a little more pose noise under fast rotation);
//                          0: whole sweeps, at the next cycle's sync
//
// Photon to photon: every effect frame records the pose it used, and once the frame has lit
// (the transmit task's stamp, LmFrameTiming) its timeline goes into the status line: light
// hit -> the report that completed the sweep -> the kernel done -> the frame's start -> lit.
// All on the P4's clock; the tracker's clock maps onto it by the fastest report, so each
// latency is "above the tracker's own minimum" (USB polling and its internal buffering, a
// constant that `/lh/lead` stands in for).
//
// OSC out (to whoever last sent OSC in: the lighthouse demo, which draws them), <= 30 Hz
// while the pose changes, and at once when tracker_state does:
//   /lh/pose         ,ffffffff  tracker_ok (0/1: locked or coasting), world <- tracker:
//                               x y z qw qx qy qz
//   /lh/fixture_pose ,f x16     world <- fixture map (`pose`), once the mount is set
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <math.h>
#include <nvs.h>
#include <string.h>

#include "firmware/p4/tracker/tracker_service.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/player_module.h"

namespace {

constexpr const char *kNvsNs = "lh";
// poll(): poses sent, and how long the loop went without calling it (status line).
uint32_t g_out = 0, g_out_fail = 0;
int64_t g_poll_last_us = 0, g_poll_gap_max_us = 0, g_send_gap_max_us = 0;
float g_mount[16];
bool g_mount_valid = false;
// The mount is written by the network task (OSC) and read by the render task (frame()).
portMUX_TYPE g_mount_mux = portMUX_INITIALIZER_UNLOCKED;
// Prediction (OSC /lh/predict, /lh/lead), written by the network task.
volatile bool g_predict = true;
volatile int32_t g_lead_us = 0;
// Never extrapolate further than this (a stalled tracker must not fly off).
constexpr int64_t kMaxPredictUs = 60 * 1000;
// Locked or coasting, the kernel publishes a pose every sweep / every 8 ms of dead
// reckoning: one older than this means the tracker task stalled, and the pose is not to be
// followed whatever its state says.
constexpr int64_t kStaleUs = 150 * 1000;

// The state to show for `p` at `now_us`: lh_health's, downgraded if the pose went stale.
uint8_t shown_health(const TrackerPose &p, int64_t now_us) {
  if (p.health >= LH_COASTING && (p.seq == 0 || now_us - p.published_us > kStaleUs)) return LH_UNCERTAIN;
  return p.health;
}

bool usable(uint8_t h) { return h >= LH_COASTING; }

const char *health_name(uint8_t h) {
  switch (h) {
    case LH_LOCKED: return "locked";
    case LH_ACQUIRING: return "acquiring";
    case LH_COASTING: return "coasting";
    case LH_UNCERTAIN: return "uncertain";
    default: return "lost";
  }
}

// Per effect frame: what it showed, until the frame has lit (render task only).
struct FrameRec {
  int64_t start_us, present_us;  // the frame's start and its predicted light-up
  int64_t light_us, trigger_us, ready_us, published_us, pose_us;
  bool tracking;
};
FrameRec g_frames[8];
int g_frame_next = 0;

// A latency stat: mean and max, µs.
struct Stat {
  uint32_t n;
  int64_t sum, max, min;
  void add(int64_t v) {
    if (n == 0 || v > max) max = v;
    if (n == 0 || v < min) min = v;
    sum += v;
    n++;
  }
  int mean_us() const { return n ? (int)(sum / n) : 0; }
};
// The photon-to-photon window (render task adds, the status line takes it; g_lat_mux).
struct Latency {
  Stat light_trigger, trigger_ready, ready_frame, frame_lit, total, horizon, lit_error;
  uint32_t predicted;
};
Latency g_lat = {};
portMUX_TYPE g_lat_mux = portMUX_INITIALIZER_UNLOCKED;

// Column-major rigid transform from a position and a unit quaternion (w, x, y, z).
void pose_to_mat(const float p[3], const float q[4], float m[16]) {
  const float w = q[0], x = q[1], y = q[2], z = q[3];
  const float r[9] = {1 - 2 * (y * y + z * z), 2 * (x * y + w * z),     2 * (x * z - w * y),
                      2 * (x * y - w * z),     1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
                      2 * (x * z + w * y),     2 * (y * z - w * x),     1 - 2 * (x * x + y * y)};
  for (int c = 0; c < 3; c++) {
    for (int k = 0; k < 3; k++) m[c * 4 + k] = r[c * 3 + k];
    m[c * 4 + 3] = 0;
  }
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  m[15] = 1;
}

// The inverse of a rigid transform: R^T, -R^T t.
void rigid_inverse(const float m[16], float o[16]) {
  for (int c = 0; c < 3; c++) {
    for (int k = 0; k < 3; k++) o[c * 4 + k] = m[k * 4 + c];
    o[c * 4 + 3] = 0;
  }
  for (int k = 0; k < 3; k++) o[12 + k] = -(o[k] * m[12] + o[4 + k] * m[13] + o[8 + k] * m[14]);
  o[15] = 1;
}

void mul(const float a[16], const float b[16], float o[16]) {
  for (int c = 0; c < 4; c++) {
    for (int r = 0; r < 4; r++) {
      float s = 0;
      for (int k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
}

void save_mount() {
  nvs_handle_t h;
  if (nvs_open(kNvsNs, NVS_READWRITE, &h) != ESP_OK) return;
  if (g_mount_valid) {
    nvs_set_blob(h, "mount", g_mount, sizeof g_mount);
  } else {
    nvs_erase_key(h, "mount");
  }
  nvs_commit(h);
  nvs_close(h);
}

void load_mount() {
  nvs_handle_t h;
  if (nvs_open(kNvsNs, NVS_READONLY, &h) != ESP_OK) return;
  size_t n = sizeof g_mount;
  g_mount_valid = nvs_get_blob(h, "mount", g_mount, &n) == ESP_OK && n == sizeof g_mount;
  nvs_close(h);
}

// --- OSC (one message per datagram, big-endian args) ----------------------------------
struct Osc {
  const char *addr;
  const char *tags;  // after the ','
  const uint8_t *args, *end;
};

size_t pad4(size_t n) { return (n + 4) & ~size_t(3); }  // a string plus its NUL, padded

bool osc_parse(const uint8_t *d, size_t n, Osc *o) {
  const size_t al = strnlen(reinterpret_cast<const char *>(d), n);
  if (al == n || pad4(al) >= n || d[pad4(al)] != ',') return false;
  const uint8_t *t = d + pad4(al);
  const size_t tl = strnlen(reinterpret_cast<const char *>(t), d + n - t);
  if (t + tl == d + n) return false;
  o->addr = reinterpret_cast<const char *>(d);
  o->tags = reinterpret_cast<const char *>(t) + 1;
  o->args = t + pad4(tl);
  o->end = d + n;
  return o->args <= o->end;
}

bool osc_words(const Osc &o, const char *want, uint32_t *out, int n) {
  if (strcmp(o.tags, want) != 0 || o.args + 4 * n > o.end) return false;
  for (int i = 0; i < n; i++) {
    const uint8_t *a = o.args + 4 * i;
    out[i] = (uint32_t)a[0] << 24 | (uint32_t)a[1] << 16 | (uint32_t)a[2] << 8 | a[3];
  }
  return true;
}

bool osc_mat(const Osc &o, float m[16]) {
  uint32_t w[16];
  if (!osc_words(o, "ffffffffffffffff", w, 16)) return false;
  memcpy(m, w, sizeof w);
  return true;
}

bool on_osc(const uint8_t *data, size_t len) {
  if (len < 4 || memcmp(data, "/lh/", 4) != 0) return false;
  Osc o;
  if (!osc_parse(data, len, &o)) return true;  // ours, malformed: drop
  if (strcmp(o.addr, "/lh/station") == 0) {
    uint32_t w[8];
    if (osc_words(o, "ifffffff", w, 8)) {
      float p[7];
      memcpy(p, w + 1, sizeof p);
      tracker_service_adopt(w[0], p);
    }
  } else if (strcmp(o.addr, "/lh/fixture") == 0) {
    float world_from_fixture[16];
    TrackerPose t;
    tracker_service_get(&t);
    if (!osc_mat(o, world_from_fixture)) return true;
    if (shown_health(t, esp_timer_get_time()) != LH_LOCKED) {
      lm_module_log("[tracker] /lh/fixture ignored: not locked (%s)\n", health_name(t.health));
      return true;
    }
    float world_from_tracker[16], tracker_from_world[16];
    pose_to_mat(t.pos, t.quat, world_from_tracker);
    rigid_inverse(world_from_tracker, tracker_from_world);
    float m[16];
    mul(tracker_from_world, world_from_fixture, m);
    taskENTER_CRITICAL(&g_mount_mux);
    memcpy(g_mount, m, sizeof m);
    g_mount_valid = true;
    taskEXIT_CRITICAL(&g_mount_mux);
    save_mount();
    lm_module_log("[tracker] mount from the fixture calibration: offset (%.3f, %.3f, %.3f) m\n", g_mount[12],
                  g_mount[13], g_mount[14]);
  } else if (strcmp(o.addr, "/lh/mount") == 0) {
    float m[16];
    if (osc_mat(o, m)) {
      taskENTER_CRITICAL(&g_mount_mux);
      memcpy(g_mount, m, sizeof m);
      g_mount_valid = true;
      taskEXIT_CRITICAL(&g_mount_mux);
      save_mount();
      lm_module_log("[tracker] mount set: offset (%.3f, %.3f, %.3f) m\n", g_mount[12], g_mount[13], g_mount[14]);
    }
  } else if (strcmp(o.addr, "/lh/unmount") == 0) {
    taskENTER_CRITICAL(&g_mount_mux);
    g_mount_valid = false;
    taskEXIT_CRITICAL(&g_mount_mux);
    save_mount();
    lm_module_log("[tracker] mount cleared\n");
  } else if (strcmp(o.addr, "/lh/stream") == 0) {
    uint32_t w;
    if (osc_words(o, "f", &w, 1)) {
      float v;
      memcpy(&v, &w, 4);
      tracker_service_stream(v > 0.5f);
      lm_module_log("[tracker] sweeps %s\n", v > 0.5f ? "streamed" : "whole");
    }
  } else if (strcmp(o.addr, "/lh/predict") == 0 || strcmp(o.addr, "/lh/lead") == 0) {
    uint32_t w;
    if (osc_words(o, "f", &w, 1)) {
      float v;
      memcpy(&v, &w, 4);
      if (o.addr[4] == 'p') {
        g_predict = v > 0.5f;
      } else {
        g_lead_us = (int32_t)(v * 1000.0f);
      }
      lm_module_log("[tracker] prediction %s, lead %d us\n", g_predict ? "on" : "off", (int)g_lead_us);
    }
  }
  return true;
}

// An OSC message of float32 args.
size_t osc_floats(uint8_t *out, const char *addr, const float *v, int n) {
  size_t o = 0;
  const size_t al = strlen(addr);
  memcpy(out, addr, al);
  memset(out + al, 0, pad4(al) - al);
  o = pad4(al);
  out[o] = ',';
  memset(out + o + 1, 'f', n);
  memset(out + o + 1 + n, 0, pad4(1 + n) - (1 + n));
  o += pad4(1 + n);
  for (int i = 0; i < n; i++) {
    uint32_t w;
    memcpy(&w, &v[i], 4);
    out[o++] = w >> 24;
    out[o++] = w >> 16;
    out[o++] = w >> 8;
    out[o++] = w;
  }
  return o;
}

// --- hooks ---------------------------------------------------------------------------
void begin() {
  load_mount();
  lm_module_log("[tracker] Vive tracker on the USB OTG port; mount %s\n", g_mount_valid ? "loaded" : "not set");
  // Not tracking: below render (10) and the loop (9), for the ~0.6 s pose bootstraps.
  // Tracking: above render and the transmit task (11), so light goes into the filter at
  // once (tens of µs a report). The USB host tasks above render too: they stamp each
  // report's arrival, which the tracker's clock mapping and latency figures rest on.
  tracker_service_start(7, 12, 13, 1);
}

// The head pose `dt_s` after the pose: constant acceleration and angular rate (world).
// Free fall is exact (the accelerometer reads 0 g, so the acceleration is gravity).
void predict(const TrackerPose &p, float dt_s, float pos[3], float quat[4]) {
  for (int i = 0; i < 3; i++) pos[i] = p.pos[i] + p.vel[i] * dt_s + 0.5f * p.accel[i] * dt_s * dt_s;
  // q' = exp(omega dt) q: the world-frame rotation omega dt, applied on the left.
  const float rx = p.omega[0] * dt_s, ry = p.omega[1] * dt_s, rz = p.omega[2] * dt_s;
  const float th = sqrtf(rx * rx + ry * ry + rz * rz);
  const float k = th > 1e-9f ? sinf(0.5f * th) / th : 0.5f;
  const float dw = cosf(0.5f * th), dx = rx * k, dy = ry * k, dz = rz * k;
  const float w = p.quat[0], x = p.quat[1], y = p.quat[2], z = p.quat[3];
  float q[4] = {dw * w - dx * x - dy * y - dz * z, dw * x + dx * w + dy * z - dz * y,
                dw * y - dx * z + dy * w + dz * x, dw * z + dx * y - dy * x + dz * w};
  const float n = 1.0f / sqrtf(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  for (int i = 0; i < 4; i++) quat[i] = q[i] * n;
}

// The frame that lit (t->lit_start_us): its timeline into the latency window, once.
void account(const LmFrameTiming *t) {
  if (t->lit_start_us == 0) return;
  for (FrameRec &f : g_frames) {
    if (f.start_us != t->lit_start_us) continue;
    if (f.tracking && f.light_us != 0) {
      taskENTER_CRITICAL(&g_lat_mux);
      Latency &l = g_lat;
      l.light_trigger.add(f.trigger_us - f.light_us);
      l.trigger_ready.add(f.ready_us - f.trigger_us);
      l.ready_frame.add(f.start_us - f.ready_us);
      l.frame_lit.add(t->lit_us - f.start_us);
      l.total.add(t->lit_us - f.light_us);
      l.lit_error.add(t->lit_us - f.present_us);
      taskEXIT_CRITICAL(&g_lat_mux);
    }
    f.start_us = 0;  // accounted
    return;
  }
}

// Render task, every effect frame (player mutex held): the pose for when this frame lights.
void frame(const LmFrameTiming *t) {
  account(t);
  TrackerPose p;
  tracker_service_get(&p);
  float m[16];
  bool mounted;
  taskENTER_CRITICAL(&g_mount_mux);
  mounted = g_mount_valid;
  memcpy(m, g_mount, sizeof m);
  taskEXIT_CRITICAL(&g_mount_mux);
  FrameRec &f = g_frames[g_frame_next];
  g_frame_next = (g_frame_next + 1) % (int)(sizeof g_frames / sizeof g_frames[0]);
  const uint8_t health = shown_health(p, t->start_us);
  const bool ok = usable(health);
  // Latency figures only for frames on an optical lock (a coasting pose's light is old).
  f = {t->start_us, t->present_us, p.light_us,    p.trigger_us, p.ready_us,
       p.published_us, p.pose_us,  health == LH_LOCKED};
  if (p.seq != 0) {
    float pos[3], quat[4];
    memcpy(pos, p.pos, sizeof pos);
    memcpy(quat, p.quat, sizeof quat);
    // Predicted while usable (locked, or coasting: a dead-reckoned pose comes with the
    // IMU's current rates); never once lost, where extrapolating is how a pose flies off.
    if (g_predict && ok && p.clock_ok) {
      int64_t ahead = t->present_us + g_lead_us - p.pose_us;
      if (ahead < 0) ahead = 0;
      if (ahead > kMaxPredictUs) ahead = kMaxPredictUs;
      predict(p, ahead * 1e-6f, pos, quat);
      taskENTER_CRITICAL(&g_lat_mux);
      g_lat.horizon.add(ahead);
      g_lat.predicted++;
      taskEXIT_CRITICAL(&g_lat_mux);
    }
    float tracker[16];
    pose_to_mat(pos, quat, tracker);
    lm_pool_publish(reinterpret_cast<const uint8_t *>("tracker"), 7, tracker, 16);
    if (mounted) {
      float pose[16];
      mul(tracker, m, pose);
      lm_pool_publish(reinterpret_cast<const uint8_t *>("pose"), 4, pose, 16);
    }
  }
  if (mounted) lm_pool_publish(reinterpret_cast<const uint8_t *>("mount"), 5, m, 16);
  const float okf = ok ? 1.0f : 0.0f;
  const float statef = health;
  lm_pool_publish(reinterpret_cast<const uint8_t *>("tracker_ok"), 10, &okf, 1);
  lm_pool_publish(reinterpret_cast<const uint8_t *>("tracker_state"), 13, &statef, 1);
}

void status() {
  static TrackerPose prev = {};
  static int64_t prev_us = 0;
  TrackerPose p;
  tracker_service_get(&p);
  TrackerLag lag;
  tracker_service_lag(&lag);
  const int64_t now = esp_timer_get_time();
  const float dt = prev_us ? (now - prev_us) / 1e6f : 1.0f;
  lm_module_log("[tracker] %s%s, pose %s (sigma %.1f mm; locks %u, lost %u, coasts %u), %u stations; IMU %.0f/s, light "
                "%.0f/s, poses %.0f/s; pos (%.3f, %.3f, %.3f); "
                "mount %s; out %u (fail %u), poll gap max %lld ms, send gap max %lld ms; "
                "lag %u ms (max %u, queue max %u, dropped %u, skipped %u)\n",
                p.configured ? "configured" : "no tracker", p.tracking ? ", tracking" : "",
                health_name(shown_health(p, now)), p.pos_sigma * 1e3f, (unsigned)p.starts, (unsigned)p.losses,
                (unsigned)p.coasts,
                (unsigned)p.stations,
                (p.imu - prev.imu) / dt, (p.pulses - prev.pulses) / dt, (p.poses - prev.poses) / dt, p.pos[0],
                p.pos[1], p.pos[2], g_mount_valid ? "set" : "not set", (unsigned)g_out, (unsigned)g_out_fail,
                (long long)(g_poll_gap_max_us / 1000), (long long)(g_send_gap_max_us / 1000),
                (unsigned)(lag.last_us / 1000), (unsigned)(lag.max_us / 1000), (unsigned)lag.depth_max,
                (unsigned)lag.dropped, (unsigned)lag.skipped);
  g_poll_gap_max_us = g_send_gap_max_us = 0;
  // Photon to photon over the window (ms, mean/max), per stage of the frames that lit.
  Latency l;
  taskENTER_CRITICAL(&g_lat_mux);
  l = g_lat;
  g_lat = {};
  taskEXIT_CRITICAL(&g_lat_mux);
  auto ms = [](const Stat &s, bool mx) { return (mx ? s.max : s.n ? s.sum / s.n : 0) / 1000.0f; };
  if (l.total.n) {
    lm_module_log("[tracker] photon->photon %.1f ms (max %.1f, %u frames): light->report %.1f/%.1f, kernel "
                  "%.1f/%.1f, ->frame %.1f/%.1f, frame->lit %.1f/%.1f (mean/max ms, above the fastest report)\n",
                  ms(l.total, false), ms(l.total, true), (unsigned)l.total.n, ms(l.light_trigger, false),
                  ms(l.light_trigger, true), ms(l.trigger_ready, false), ms(l.trigger_ready, true),
                  ms(l.ready_frame, false), ms(l.ready_frame, true), ms(l.frame_lit, false), ms(l.frame_lit, true));
    lm_module_log("[tracker] prediction %s (lead %d us): ahead %.1f ms (max %.1f) on %u frames; lit vs "
                  "expected %+.1f ms (%+.1f..%+.1f)\n",
                  g_predict ? "on" : "off", (int)g_lead_us, ms(l.horizon, false), ms(l.horizon, true),
                  (unsigned)l.predicted, ms(l.lit_error, false), l.lit_error.min / 1000.0f, ms(l.lit_error, true));
  }
  // Where the tracker task's time went (µs per item, mean/max) and its share of a core.
  LhProfile pr;
  tracker_service_profile(&pr);
  auto us = [](uint64_t c, uint32_t n) { return n ? (float)c / n / 400.0f : 0.0f; };
  uint64_t all = 0;
  for (int k = 0; k < 4; k++) all += pr.cycles[k];
  lm_module_log("[tracker] cpu %.1f%% of a core: decode %u x %.0f us (max %.0f), imu %u x %.0f (%.0f), light %u x "
                "%.1f (%.0f), pose %u x %.0f (%.0f); light %.2f ms late (max %.2f); %u sweeps in %u parts%s\n",
                all / 4e6f / dt, (unsigned)pr.n[0], us(pr.cycles[0], pr.n[0]), pr.max_cycles[0] / 400.0f,
                (unsigned)pr.n[1], us(pr.cycles[1], pr.n[1]), pr.max_cycles[1] / 400.0f, (unsigned)pr.n[2],
                us(pr.cycles[2], pr.n[2]), pr.max_cycles[2] / 400.0f, (unsigned)pr.n[3], us(pr.cycles[3], pr.n[3]),
                pr.max_cycles[3] / 400.0f,
                pr.light_reports ? pr.light_late_sum_us / 1000.0f / pr.light_reports : 0.0f,
                pr.light_late_max_us / 1000.0f, (unsigned)(p.sweeps - prev.sweeps),
                (unsigned)(p.sweep_parts - prev.sweep_parts), p.streaming ? " (streamed)" : "");
  prev = p;
  prev_us = now;
}

// The pose out to the host that drives us (it draws the tracker and the fixture).
void poll() {
  static int64_t last_us = 0;
  static uint32_t last_seq = 0;
  static uint8_t last_state = LH_LOST;
  const int64_t now = esp_timer_get_time();
  if (g_poll_last_us && now - g_poll_last_us > g_poll_gap_max_us) g_poll_gap_max_us = now - g_poll_last_us;
  g_poll_last_us = now;
  TrackerPose p;
  tracker_service_get(&p);
  const uint8_t state = shown_health(p, now);
  // A change of state goes out at once (the host must not draw a lost pose as tracked);
  // new poses at most every 33 ms.
  if (p.seq == 0 || (state == last_state && (now - last_us < 33 * 1000 || p.seq == last_seq))) return;
  last_state = state;
  if (last_us && now - last_us > g_send_gap_max_us) g_send_gap_max_us = now - last_us;
  last_us = now;
  last_seq = p.seq;
  uint8_t buf[24 + 24 + 16 * 4];
  const float v[8] = {usable(state) ? 1.0f : 0.0f, p.pos[0], p.pos[1], p.pos[2], p.quat[0], p.quat[1], p.quat[2], p.quat[3]};
  if (lm_module_osc_send(buf, osc_floats(buf, "/lh/pose", v, 8))) {
    g_out++;
  } else {
    g_out_fail++;
  }
  float m[16];
  taskENTER_CRITICAL(&g_mount_mux);
  const bool mounted = g_mount_valid;
  memcpy(m, g_mount, sizeof m);
  taskEXIT_CRITICAL(&g_mount_mux);
  if (mounted) {
    float tracker[16], pose[16];
    pose_to_mat(p.pos, p.quat, tracker);
    mul(tracker, m, pose);
    lm_module_osc_send(buf, osc_floats(buf, "/lh/fixture_pose", pose, 16));
  }
}

const LmPlayerModule kTrackerModule = {"vive-tracker", begin, nullptr, on_osc, status, poll, frame};
LM_PLAYER_MODULE(kTrackerModule);

}  // namespace
