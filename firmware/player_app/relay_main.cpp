// The C6 front end of a P4 + C6 board, as a pure relay (docs/design/p4-c6-split.md §4.3).
//
// The P4 is the player: it renders, runs the effects engine and keeps the player state.
// This C6 keeps what belongs to the radio and nothing else:
//   - the heapless netstack (Wi-Fi, DHCP, TCP), the per-device TLS identity and wss :443,
//     mDNS, and OSC on udp/9000 (forwarded to the P4);
//   - BLE Improv provisioning and the BLE player transport;
//   - the Wi-Fi rejoin policy (set/get_wifi_policy are answered here: the radio is ours);
//   - the device's identity (its MAC and name: BLE and mDNS advertise them; the P4 takes
//     them over the link so its Welcome names the device the app found);
//   - get_tls_info (the TLS identity is this chip's);
//   - this image's own OTA hooks (ota_app.cpp: crash-loop guard, health check);
//   - the mesh layer (docs/design/mesh.md §8.2, mesh_glue.h; off until this fixture joins a
//     mesh): the C6 is the mesh node, the P4 the endpoint. The membership and the frame
//     counter live in /lfs here; get_mesh / mesh_admin are answered here; a control the mesh
//     relays to this fixture goes to the P4 (LK_MESH) and its result back to the mesh; the
//     P4's HEARTBEAT carries the status this member broadcasts. Mesh time on the P4's render
//     clock, effect sharing (M6) and the gateway's mesh_send are the next step: until then
//     the P4 answers mesh_send itself (error{unsupported}).
// Every other player message goes to the P4 as link frames over the SDIO slave
// (frontend_link.cpp) and its reply comes back the same way. While the P4 is down the
// answer is error{player_unavailable}: there is no second player core here to answer from.
//
// It replaces main.cpp's old LM_FRONTEND build, which linked the whole player core and
// effects engine (~62 KB of RAM: FX_ARENA, ARENA_MEM, DECK_A, FX_AUX, PLAYER) only to
// answer while the P4 was down.
#include <Arduino.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <esp_littlefs.h>
#include <esp_mac.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "device_cert.h"
#include "firmware/ota/ota_ffi.h"
#include "firmware/player_app/agent_bundle.h"  // generated: LM_AGENT_BUNDLE_URL / _SHA256
#include "firmware/player_app/build_info.h"    // generated: LM_GIT_COMMIT / LM_VERSION
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/ota_app.h"
#include "firmware/player_app/player_ffi.h"  // the Wi-Fi policy types (wifi_ffi.rs)
#include "firmware/player_app/serial_log.h"
#include "firmware/p4/link/link_codec.h"
#include "flash_suspend/lm_flash_suspend.h"
#include "frontend_link.h"
#include "improv_ble.h"
#include "netstack_transport.h"
#include "tls_region.h"

// relay_ffi.rs
extern "C" {
int32_t lm_relay_device_name(const uint8_t *frame, size_t len, uint8_t *out, size_t cap);
int32_t lm_relay_local(const uint8_t *frame, size_t len, uint8_t *out, size_t cap);
void lm_relay_set_identity(const char *mac, const char *name, const char *fw, const char *tls_state);
}

// The mesh (netstack_transport.cpp / mesh_glue.h), as main.cpp declares them.
extern "C" int32_t lm_mesh_app(uint32_t conn, const uint8_t *in, size_t len, uint8_t *out, size_t cap,
                               const uint8_t **inner, uint32_t *inner_len);
extern "C" void lm_mesh_sessions(uint32_t ws, uint32_t ble);
extern "C" uint32_t lm_mesh_report_line(uint32_t what, uint32_t idx, char *out, uint32_t cap);

// The netstack's loop with mbedtls nested inside a TLS write, plus the relay's own frames
// (none large: no player core). The player's 12 KB bound holds with room to spare.
SET_LOOP_TASK_STACK_SIZE(12 * 1024);

namespace {

constexpr const char *kFsBase = "/lfs";
constexpr const char *kFsPartition = "spiffs";
constexpr const char *kTlsIdentityPath = "/lfs/tls_id.bin";
// The loop's priority: the level the player's loop takes while a client is on (#371). The
// front end renders nothing, so nothing else needs the CPU more; it sleeps a tick per pass.
constexpr UBaseType_t kLoopPrio = 10;
// The BLE central's session id over the link; the wss sessions are 1..LM_WSS_SESSIONS
// (netstack_ws_session()). Its pushes aren't relayed (the P4 pushes to wss sessions).
constexpr uint16_t kBleSession = 0x100;

// ClientMessage arms routed here (shared/protocol/proto/ledmapper.proto).
constexpr int32_t kArmSetDeviceName = 27;
constexpr int32_t kArmGetTlsInfo = 45;
constexpr int32_t kArmOtaBegin = 70;
constexpr int32_t kArmGetOtaStatus = 74;
constexpr int32_t kArmOtaReboot = 75;
// The mesh's own arms (mesh_gw.rs): this chip runs the mesh layer.
constexpr int32_t kArmGetMesh = 100;
constexpr int32_t kArmMeshAdmin = 101;

Preferences g_prefs;
bool g_fs_ok = false;
char g_mac[18] = "";
char g_name[33] = "Led Widget";

// One reply buffer for wss and BLE, with the WS header headroom the transport writes in
// place (kWsSendHeadroom). The P4's replies land here too (frontend_forward).
struct {
  uint8_t headroom[16];
  uint8_t data[2048];
} g_tx;
static_assert(sizeof g_tx.headroom >= kWsSendHeadroom, "tx needs WS header headroom");
uint8_t (&tx)[2048] = g_tx.data;

char g_tls_state[16] = "";
char g_cert_sha[65] = "";
bool g_tls_persisted = false;

struct {
  uint32_t forwarded, unavailable, local, mesh_app, mesh_ctl, mesh_ctl_failed;
} g_stats;
// The lowest free internal heap seen since the last status line (sampled every loop).
uint32_t g_heap_window_min = UINT32_MAX;

int reply_error(const char *code, const char *msg) {
  const int32_t n = ota_encode_error(code, msg, tx, sizeof tx);
  return n > 0 ? (int)n : -1;
}

// A rename: persisted, advertised over BLE and mDNS, and handed to the P4 (LK_OP_NAME).
void apply_rename(const uint8_t *msg, size_t len) {
  char name[33];
  const int32_t n = lm_relay_device_name(msg, len, reinterpret_cast<uint8_t *>(name), sizeof name);
  if (n <= 0 || strncmp(name, g_name, sizeof g_name) == 0) return;
  strncpy(g_name, name, sizeof g_name - 1);
  g_name[sizeof g_name - 1] = 0;
  g_prefs.putString("name", g_name);
  improv_ble_set_name(g_name);
  lm_relay_set_identity(nullptr, g_name, nullptr, nullptr);
  frontend_link_set_identity(g_mac, g_name);
  Log().printf("[relay] renamed to \"%s\"\n", g_name);
}

// -- the mesh (mesh_glue.h's hooks; main.cpp has the player's) ----------------------------

// The mesh's gateway sessions are per connection, kiosk-source numbered (1 = wss, 2 = BLE;
// player_ffi.h), as on the players, which serve one wss client. This front end serves
// LM_WSS_SESSIONS: the wss session that last used a mesh arm owns connection 1, and another
// session taking it over first ends whatever session (an admin unlock) the owner held, so
// one client never rides another's unlock.
uint16_t g_mesh_ws_owner = 0;
bool g_mesh_ws_closed = false;  // the owner's session ended (netstack_session_closed)
void (*g_session_closed_next)(uint16_t) = nullptr;

void poll_mesh_sessions() {
  if (g_mesh_ws_closed) {
    g_mesh_ws_closed = false;
    g_mesh_ws_owner = 0;
  }
  lm_mesh_sessions(g_mesh_ws_owner != 0, improv_ble_central_connected());
}

// get_mesh / mesh_admin: the reply's length in tx, or -1 when the mesh layer passes on it.
int mesh_app(uint16_t session, const uint8_t *msg, size_t len) {
  uint32_t conn = LM_KIOSK_SRC_BLE;
  if (session != kBleSession) {
    conn = LM_KIOSK_SRC_WSS;
    if (session != g_mesh_ws_owner) {
      if (g_mesh_ws_owner != 0) lm_mesh_sessions(0, improv_ble_central_connected());
      g_mesh_ws_owner = session;
      g_mesh_ws_closed = false;
      lm_mesh_sessions(1, improv_ble_central_connected());
    }
  }
  const uint8_t *inner = nullptr;
  uint32_t inner_len = 0;
  const int32_t r = lm_mesh_app(conn, msg, len, tx, sizeof tx, &inner, &inner_len);
  // -3 (dispatch an inner here too) is mesh_send's, which this front end doesn't route yet.
  return r >= 0 ? (int)r : -1;
}

}  // namespace

// The relayed control for this fixture (after the mesh tick, loopTask): the P4 is the
// player, so it goes over the link and the mesh gets the P4's result. A P4 that is down or
// silent fails it with a kMeshP4* code (frontend_link.h); the gateway reports it missing.
extern "C" int32_t lm_mesh_member_dispatch(const uint8_t *in, uint32_t len, uint32_t *code) {
  *code = 0;
  g_stats.mesh_ctl++;
  const int st = frontend_forward_mesh(in, len, code, 1000);
  if (st != 0) g_stats.mesh_ctl_failed++;
  return st;
}

// A finished mesh_send result to its connection (unused until the gateway's mesh_send is
// routed here; kept so the contract is whole).
extern "C" void lm_mesh_push(uint32_t conn, uint8_t *frame, uint32_t len) {
  if (conn == LM_KIOSK_SRC_BLE) {
    if (improv_ble_central_connected()) player_ble_push(frame, len);
  } else if (g_mesh_ws_owner != 0) {
    netstack_ws_send_to(g_mesh_ws_owner, frame, len);
  }
}

// What this member broadcasts: the P4's player status from its HEARTBEAT (0s while the P4
// is down: the gateway lists the fixture with fps 0).
extern "C" void lm_mesh_status_fill(uint32_t *fps, uint32_t *brightness, uint32_t *firmware) {
  if (!frontend_p4_status(fps, brightness, firmware)) *fps = *brightness = *firmware = 0;
}

// Background mesh work (the tick, session crypto) runs below the render task on a player
// (PR-40). Nothing renders here: loopTask keeps its priority.
extern "C" uint32_t lm_prio_below_render() { return (uint32_t)uxTaskPriorityGet(nullptr); }
extern "C" void lm_prio_restore(uint32_t) {}

// The mesh's console lines for the P4's console ("[c6] [mesh] ..."): this chip's console
// isn't wired on the P4 boards.
extern "C" void lm_mesh_console_tee(const char *line) { frontend_link_log(line); }

// The show epoch (mesh time, M4) mapped onto the player's time base: the P4's render clock
// is the next step (the C6<->P4 clock offset, docs/design/mesh.md §10.2). Until then the
// mapped time base is kept here, so the mesh layer's reconciliation is consistent, and the
// P4 renders on its own clock (no frame alignment across members).
namespace {
int64_t g_tb_ms = 0;
bool g_tb_set = false;
bool g_tb_align = false;
}  // namespace
extern "C" int32_t lm_mesh_tb(int32_t op, int64_t *epoch_ms, int64_t) {
  switch (op) {
    case 0:
      *epoch_ms = g_tb_ms;
      return g_tb_set ? 1 : 0;
    case 1:
      g_tb_ms = *epoch_ms;
      g_tb_set = true;
      return 1;
    case 2:
      g_tb_ms = 0;
      g_tb_set = false;
      return 1;
    case 3:
      g_tb_align = *epoch_ms != 0;
      return 1;
    default:
      return 0;
  }
}

// Effect sharing (mesh M6, mesh_blob.rs) is the next step: the effect frames are the P4's.
// Until then this member holds no effect file, stages nothing (a shared effect then loads
// at once, through lm_mesh_member_dispatch, i.e. on the P4), and has no deck B or scene to
// hand a catch-up. lm_fx_check_effect answers for the gateway's share, never reached here.
extern "C" uint32_t lm_mesh_effect_file(uint8_t *, uint32_t) { return 0; }
extern "C" int32_t lm_mesh_stage(const uint8_t *, uint32_t, uint32_t, const uint8_t **replaced) {
  *replaced = nullptr;
  return 0;  // "its time has passed": loaded now, through the dispatch
}
extern "C" uint32_t lm_mesh_staged_take(const uint8_t **frame) {
  *frame = nullptr;
  return 0;
}
extern "C" void lm_mesh_staged_cancel() {}
extern "C" int32_t lm_mesh_scene_frames(uint8_t *, uint32_t) { return 0; }
extern "C" const uint8_t *lm_mesh_deckb_frame(uint32_t *len) {
  *len = 0;
  return nullptr;
}
extern "C" uint32_t lm_fx_check_effect(const uint8_t *, size_t) { return 1; }

namespace {

// One player message from wss session `session` (or the BLE central): the reply's length
// in tx, 0 for none, or -1 to drop the session (the client resumes).
int handle(uint16_t session, const uint8_t *msg, size_t len) {
  const int32_t arm = lm_envelope_arm(msg, len);
  // The TLS identity and the Wi-Fi policy are this chip's: answered here, P4 or not.
  if (arm == kArmGetTlsInfo) {
    g_stats.local++;
    const int32_t n = ota_encode_tls_info(g_tls_state, g_cert_sha, g_tls_persisted, tx, sizeof tx);
    return n > 0 ? (int)n : -1;
  }
  {
    const int32_t n = lm_relay_local(msg, len, tx, sizeof tx);
    if (n != -1) {
      g_stats.local++;
      return n > 0 ? (int)n : -1;
    }
  }
  // The mesh's membership and listing are this chip's: the mesh layer runs here. A kiosk
  // (the P4's player state) refuses them, as a locked C6 player's kiosk gate does; the
  // owner turns the kiosk off to administer the mesh (no per-session kiosk unlock here yet).
  if (arm == kArmGetMesh || arm == kArmMeshAdmin) {
    if (frontend_p4_kiosk()) {
      g_stats.local++;
      return reply_error("kiosk_locked", "not available while the kiosk is on (turn kiosk mode off first)");
    }
    const int n = mesh_app(session, msg, len);
    if (n >= 0) {
      g_stats.mesh_app++;
      return n;
    }
  }
  // Firmware updates are the P4's (ota_p4.cpp, docs/design/p4-c6-split.md §5.1): its
  // package carries this front end's image too, and it reflashes this C6 at its next
  // boot. Writing a sector and the final read-back verify take a moment, hence the longer
  // wait. While the P4 is down get_ota_status is answered here (this image's own status),
  // so a client watching an update sees the board still there; the other arms get no
  // reply, and the client's resume retries them once the P4 is back.
  if (arm >= kArmOtaBegin && arm <= kArmOtaReboot) {
    const int n = frontend_forward(session, msg, len, tx, sizeof tx, 10000);
    if (n > 0) return n;
    if (n == -2) return -1;  // undelivered: drop the session, the client resumes
    if (n == 0 || arm != kArmGetOtaStatus) return 0;
    return ota_app_dispatch(msg, len, tx, sizeof tx);
  }
  const bool p4_up = frontend_p4_up();
  // A rename is applied here too (BLE and mDNS advertise the name), then forwarded: the
  // P4's reply is the Welcome that echoes it.
  if (arm == kArmSetDeviceName && p4_up) apply_rename(msg, len);
  if (p4_up) {
    const int n = frontend_forward(session, msg, len, tx, sizeof tx, 1000);
    g_stats.forwarded++;
    if (n >= 0) return n;
    if (n == -2) return -1;  // the P4's, undelivered: drop the session, the client retries
    if (frontend_p4_up()) return reply_error("reply_too_large", "the player's reply did not fit");
  }
  g_stats.unavailable++;
  return reply_error("player_unavailable", "the player (P4) is not up yet; retry in a moment");
}

// -- littlefs (the TLS identity lives there) -------------------------------------------

size_t fs_read_file(const char *path, uint8_t *buf, size_t cap);
size_t tls_store_read(uint8_t *buf, size_t cap) { return fs_read_file(kTlsIdentityPath, buf, cap); }

// Temp + fsync + rename, as the player (main.cpp fs_write_file): a reset mid-write leaves
// the previous file or the new one, never a torn one.
bool fs_write_file(const char *path, const uint8_t *buf, size_t len) {
  if (!g_fs_ok) return false;
  char tmp[64];
  snprintf(tmp, sizeof tmp, "%s.tmp", path);
  FILE *f = fopen(tmp, "wb");
  if (f == nullptr) return false;
  setvbuf(f, nullptr, _IONBF, 0);
  size_t w = fwrite(buf, 1, len, f);
  bool synced = fflush(f) == 0 && fsync(fileno(f)) == 0;
  if (fclose(f) != 0 || w != len || !synced) {
    remove(tmp);
    return false;
  }
  return rename(tmp, path) == 0;
}

// Read up to `cap` bytes of `path`: the count, 0 when it is missing (or littlefs is down).
size_t fs_read_file(const char *path, uint8_t *buf, size_t cap) {
  if (!g_fs_ok) return 0;
  FILE *f = fopen(path, "rb");
  if (f == nullptr) return 0;
  setvbuf(f, nullptr, _IONBF, 0);
  size_t n = fread(buf, 1, cap, f);
  fclose(f);
  return n;
}

bool tls_store_write(const uint8_t *buf, size_t len) { return fs_write_file(kTlsIdentityPath, buf, len); }

const DeviceCertStore kTlsStore = {tls_store_read, tls_store_write};

// The mesh's two files, as the player keeps them (main.cpp): the frame counter's high-water
// mark (docs/design/mesh.md §7.5: persisted before a counter in its block is used, so a
// reboot never reuses an AES-CCM nonce) and the membership (§7.2; present = in a mesh, so
// the mesh comes on at boot). Arrays: flash, not .data pointers.
const char kMeshCounterPath[] = "/lfs/mesh_ctr.bin";
const char kMeshStatePath[] = "/lfs/mesh.bin";

}  // namespace

extern "C" uint32_t lm_mesh_counter_load(uint64_t *mark) {
  *mark = 0;
  uint64_t v = 0;
  if (fs_read_file(kMeshCounterPath, reinterpret_cast<uint8_t *>(&v), sizeof v) != sizeof v) return 0;
  *mark = v;
  return 1;
}

extern "C" uint32_t lm_mesh_counter_store(uint64_t mark) {
  return fs_write_file(kMeshCounterPath, reinterpret_cast<const uint8_t *>(&mark), sizeof mark) ? 1 : 0;
}

extern "C" uint32_t lm_mesh_state_load(uint8_t *buf, uint32_t cap) {
  return (uint32_t)fs_read_file(kMeshStatePath, buf, cap);
}

// store(nullptr, 0) erases it (leave, eject): 1 once it is gone.
extern "C" uint32_t lm_mesh_state_store(const uint8_t *buf, uint32_t len) {
  if (buf == nullptr || len == 0) {
    if (!g_fs_ok) return 0;
    remove(kMeshStatePath);
    FILE *f = fopen(kMeshStatePath, "rb");
    if (f == nullptr) return 1;
    fclose(f);
    return 0;
  }
  return fs_write_file(kMeshStatePath, buf, len) ? 1 : 0;
}

namespace {

bool fs_mount() {
  esp_vfs_littlefs_conf_t conf = {};
  conf.base_path = kFsBase;
  conf.partition_label = kFsPartition;
  conf.format_if_mount_failed = true;
  return esp_vfs_littlefs_register(&conf) == ESP_OK;
}

// -- the Wi-Fi rejoin policy (wifi_ffi.rs <-> netstack_transport), as the player -----

NetstackWifiPolicy to_ns(const LmWifiPolicy &p) {
  return NetstackWifiPolicy{p.mode, p.scan_cap_s, p.interval_s, p.decay_after_h, p.sparse_interval_s};
}
uint32_t g_wifi_pol_gen = 0;
uint32_t g_wifi_unseen_saved = 0;
const char *const kModes[] = {"auto", "fixed", "manual", "offline"};

void wifi_policy_begin() {
  uint8_t rec[18];
  size_t n = g_prefs.getBytesLength("wifi_pol") == sizeof rec ? g_prefs.getBytes("wifi_pol", rec, sizeof rec) : 0;
  LmWifiPolicy p;
  lm_wifi_policy_seed(n ? rec : nullptr, n, &p);
  g_wifi_pol_gen = lm_wifi_policy_gen();
  NetstackWifiPolicy np = to_ns(p);
  netstack_set_wifi_policy(&np);
  g_wifi_unseen_saved = g_prefs.getUInt("wifi_unseen", 0);
  netstack_set_unseen_base(g_wifi_unseen_saved);
  Log().printf("[wifi] policy %s (cap %us, every %us, decay %uh -> %us)%s\n", kModes[p.mode <= 3 ? p.mode : 0],
               (unsigned)p.scan_cap_s, (unsigned)p.interval_s, (unsigned)p.decay_after_h,
               (unsigned)p.sparse_interval_s, g_wifi_unseen_saved ? " network unseen across reboots" : "");
}

// Every loop: apply + persist a policy change, forward a rejoin request, publish the live
// link state, and persist the unseen-network clock (hourly).
void poll_wifi_policy() {
  NetstackWifiPolicy np;
  if (netstack_take_policy_change(&np)) {
    LmWifiPolicy p = {np.mode, np.scan_cap_s, np.interval_s, np.decay_after_h, np.sparse_interval_s};
    lm_wifi_policy_adopt(&p);
  }
  uint32_t gen = lm_wifi_policy_gen();
  if (gen != g_wifi_pol_gen) {
    g_wifi_pol_gen = gen;
    LmWifiPolicy p;
    uint8_t rec[18];
    lm_wifi_policy_get(&p, rec);
    np = to_ns(p);
    netstack_set_wifi_policy(&np);
    g_prefs.putBytes("wifi_pol", rec, sizeof rec);
    Log().printf("[wifi] policy -> %s (saved)\n", kModes[p.mode <= 3 ? p.mode : 0]);
  }
  if (lm_wifi_take_rejoin()) netstack_wifi_rejoin();
  NetstackWifiStatus st;
  netstack_wifi_status(&st);
  LmWifiStatus ls;
  ls.state = st.state;
  ls.radio_on = st.radio_on;
  ls.decayed = st.decayed;
  ls.next_scan_s = st.next_scan_s;
  ls.scans = st.scans;
  ls.unseen_s = st.unseen_s;
  memcpy(ls.ssid, st.ssid, sizeof ls.ssid);
  lm_wifi_report(&ls);
  lm_wifi_set_ota_pending(ota_app_pending());
  uint32_t u = st.unseen_s;
  if ((u == 0 && g_wifi_unseen_saved != 0) || u >= g_wifi_unseen_saved + 3600u) {
    g_wifi_unseen_saved = u;
    g_prefs.putUInt("wifi_unseen", u);
  }
}

// -- identity -------------------------------------------------------------------------

void identity_begin() {
  // The BT MAC: the address the BLE advertisement uses and the app knows the device by.
  uint8_t macb[6] = {0};
  esp_read_mac(macb, ESP_MAC_BT);
  snprintf(g_mac, sizeof g_mac, "%02X:%02X:%02X:%02X:%02X:%02X", macb[0], macb[1], macb[2], macb[3],
           macb[4], macb[5]);
  // The player's default name (FNV-1a of the MAC), or the user's from NVS.
  uint32_t h = 2166136261u;
  for (int i = 0; i < 6; i++) h = (h ^ macb[i]) * 16777619u;
  snprintf(g_name, sizeof g_name, "Led Widget %06lX", (unsigned long)(h & 0xFFFFFF));
  String stored = g_prefs.getString("name", "");
  if (stored.length() > 0) {
    strncpy(g_name, stored.c_str(), sizeof g_name - 1);
    g_name[sizeof g_name - 1] = 0;
  }
  lm_relay_set_identity(g_mac, g_name, LM_VERSION, nullptr);
  frontend_link_set_identity(g_mac, g_name);
}

// A JSON string body (no quotes) of `s` into out: the device name is the user's.
size_t json_escape(const char *s, char *out, size_t cap) {
  size_t o = 0;
  for (; *s && o + 7 < cap; s++) {
    const unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      out[o++] = '\\';
      out[o++] = (char)c;
    } else if (c < 0x20) {
      o += snprintf(out + o, cap - o, "\\u%04x", c);
    } else {
      out[o++] = (char)c;
    }
  }
  out[o] = 0;
  return o;
}

bool is_release_version(const char *v) {
  int parts = 0;
  bool digit = false;
  for (const char *c = v;; c++) {
    if (*c == '.' || *c == 0) {
      if (!digit) return false;
      parts++;
      digit = false;
      if (*c == 0) break;
    } else if (*c >= '0' && *c <= '9') {
      digit = true;
    } else {
      return false;
    }
  }
  return parts == 3 && strcmp(v, "0.0.0") != 0;
}

void log_status() {
  const TlsRegionStats &tls = tls_region_stats();
  const uint32_t f = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  // win= the lowest free heap since the last line; ws= wss sessions upgraded now. The P4's
  // console gets the line too (this chip's console isn't wired on the P4 boards).
  char line[220];
  snprintf(line, sizeof line,
           "[relay] heap=%u max=%u min=%u win=%u ws=%d rekeys=%u tls=%u/%u slots=%u/%u fb=%u fwd=%u unavail=%u "
           "local=%u\n",
           (unsigned)f, (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)(g_heap_window_min == UINT32_MAX ? f : g_heap_window_min), netstack_sessions_open(),
           (unsigned)netstack_rekey_count(), (unsigned)tls.small_peak, (unsigned)tls.small_size,
           (unsigned)tls.slots_peak, (unsigned)tls.slots, (unsigned)tls.fallbacks, (unsigned)g_stats.forwarded,
           (unsigned)g_stats.unavailable, (unsigned)g_stats.local);
  g_heap_window_min = UINT32_MAX;
  Log().print(line);
  frontend_link_log(line);
  char net[200];
  netstack_net_stats(net, sizeof net);
  Log().printf("[net] t=%lu %s\n", (unsigned long)millis(), net);
  char ln[160];
  frontend_link_stats(ln, sizeof ln);
  Log().printf("[link] %s\n", ln);
  auto stk_free = [](const char *name) -> unsigned {
    TaskHandle_t h = xTaskGetHandle(name);
    return h ? (unsigned)uxTaskGetStackHighWaterMark(h) : 0u;
  };
  Log().printf("[stack] free loopTask=%u logdrain=%u\n", stk_free("loopTask"), stk_free("logdrain"));
  // The mesh, for the P4's console (MESH INFO, every other line: the C6's own console isn't
  // wired on the P4 boards). Nothing while it is off.
  static uint32_t passes = 0;
  if (passes++ % 2 == 0) {
    char info[640];
    for (uint32_t i = 0; i < 8 && lm_mesh_report_line(0, i, info, sizeof info - 1); i++) {
      strcat(info, "\n");
      Log().print(info);
      frontend_link_log(info);
    }
    if (g_stats.mesh_app || g_stats.mesh_ctl) {
      snprintf(line, sizeof line, "[relay] mesh app=%u ctl=%u ctl_failed=%u\n", (unsigned)g_stats.mesh_app,
               (unsigned)g_stats.mesh_ctl, (unsigned)g_stats.mesh_ctl_failed);
      Log().print(line);
      frontend_link_log(line);
    }
  }
}

}  // namespace

// -- the transport's lm_* seam (netstack_transport.h) ----------------------------------

int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply) {
  *reply = tx;
  return handle(netstack_ws_session(), in, len);
}

// Every reply is the P4's or a must-deliver of ours: none may be dropped on a full window.
bool lm_ws_reply_droppable() { return false; }
// A newcomer may take the session over (#444): the uploads and updates that make a session
// busy are the P4's, and it refuses a second client's window itself (link_transport.cpp).
bool lm_ws_session_busy() { return false; }

// Improv Identify (#605): the shared netstack loop starts the picker's Blink here. The
// relay front end drives no LEDs (the P4 renders), so there is nothing to blink.
void player_identify_start() {}
// OSC on udp/9000: the uniforms (and any module's addresses) are the P4's.
void lm_netstack_osc_rx(const uint8_t *data, size_t len) { frontend_link_osc(data, len); }

// The BLE player transport (improv_ble_netstack.cpp): the same contract as lm_ws_dispatch.
int lm_player_ble_reply(const uint8_t *in, size_t len, const uint8_t **reply) {
  *reply = tx;
  return handle(kBleSession, in, len);
}

// Kiosk mode (docs/design/kiosk-mode.md) is the P4's player state; this chip never takes
// a kiosk config, so Improv keeps taking credentials, as the old front end did.
extern "C" bool lm_kiosk_enabled(void) { return false; }

// GET /.well-known/splanc.json: the agent discovery manifest. The device and firmware
// fields are this board's (the P4 bundles this image, so its version and commit are the
// P4's); the protocol features are the P4's and come with its Welcome over /ws.
int lm_agent_manifest_body(const char *cert_sha256, const uint8_t **body) {
  char name[100];
  json_escape(g_name, name, sizeof name);
  char *out = reinterpret_cast<char *>(tx);
  const size_t cap = sizeof tx;
  int n = snprintf(out, cap,
                   "{\"schema\":\"splanc-agent/1\",\"device\":{\"id\":\"%s\",\"name\":\"%s\",\"board\":\"\"},"
                   "\"firmware\":{\"version\":\"%s\",\"commit\":\"%s\",\"dirty\":%s},"
                   "\"protocol\":{\"package\":\"ledmapper.v1\",\"ws_path\":\"/ws\",\"profile\":\"core\","
                   "\"features\":[],\"fxb_format\":0},\"tls\":{\"cert_sha256\":\"%s\"",
                   g_mac, name, LM_VERSION, LM_GIT_COMMIT, LM_GIT_DIRTY ? "true" : "false", cert_sha256);
  if (n > 0 && (size_t)n < cap && g_tls_state[0]) {
    n += snprintf(out + n, cap - n, ",\"state\":\"%s\",\"persisted\":%s", g_tls_state,
                  g_tls_persisted ? "true" : "false");
  }
  if (n > 0 && (size_t)n < cap) {
    static const char kUrl[] = LM_AGENT_BUNDLE_URL;
    static const char kSha[] = LM_AGENT_BUNDLE_SHA256;
    if (is_release_version(LM_VERSION) && !LM_GIT_DIRTY) {
      char url[200];
      if (kUrl[0]) {
        snprintf(url, sizeof url, "%s", kUrl);
      } else {
        snprintf(url, sizeof url,
                 "https://github.com/fughilli/splanc/releases/download/firmware-v%s/splanc-agent-%s.tgz",
                 LM_VERSION, LM_VERSION);
      }
      n += snprintf(out + n, cap - n,
                    "},\"bundle\":{\"url\":\"%s\",\"sha256\":\"%s\",\"mcp\":{\"command\":\"npx\",\"args\":"
                    "[\"-y\",\"@splanc/agent@%s\",\"--host\",\"{host}\"]}}}",
                    url, kSha, LM_VERSION);
    } else {
      n += snprintf(out + n, cap - n, "},\"bundle\":null}");
    }
  }
  *body = tx;
  return n > 0 && (size_t)n < cap ? n : -1;
}

// TLS identity readiness for get_tls_info, the manifest and the mDNS TXT.
void lm_publish_tls_info(const char *state, const char *cert_sha256, bool persisted) {
  strncpy(g_tls_state, state, sizeof g_tls_state - 1);
  strncpy(g_cert_sha, cert_sha256, sizeof g_cert_sha - 1);
  g_tls_persisted = persisted;
  lm_relay_set_identity(nullptr, nullptr, nullptr, g_tls_state);
}

int lm_mdns_reply(const uint8_t *query, size_t qlen, uint16_t src_port, const uint8_t *ip, uint8_t *out,
                  size_t cap, bool *unicast) {
  return query ? (int)lm_mdns_respond(query, qlen, src_port, ip, out, cap, unicast)
               : (int)lm_mdns_announce(ip, out, cap);
}

// Credentials a provisioned network leased on (wifi_creds.h): the player's NVS keys, so a
// reboot rejoins on its own.
bool lm_store_wifi_credentials(const char *ssid, const char *pass) {
  size_t sn = g_prefs.putString("ssid", ssid);
  size_t pn = g_prefs.putString("pass", pass);
  return sn == strlen(ssid) && pn == strlen(pass);
}

// Console lines "WIFI MODE …" / "WIFI REJOIN" / "WIFI STATUS" (the transport handles its
// own link diagnostics first and passes the rest here).
void netstack_console_hook(const char *line, size_t len) {
  if (len < 5) return;
  char reply[200];
  int32_t n = lm_wifi_console(reinterpret_cast<const uint8_t *>(line) + 5, len - 5,
                              reinterpret_cast<uint8_t *>(reply), sizeof reply);
  if (n < 0) {
    Serial.printf("[wifi] console: WIFI MODE <auto|fixed|manual|offline> [cap=S] [every=S] [decay=H] "
                  "[sparse=S] [force] | WIFI REJOIN | WIFI STATUS | WIFI SCAN | WIFI DHCP | WIFI GIVEUP | "
                  "WIFI SCANMISS <n>\n");
    return;
  }
  Serial.printf("%s\n", reply);
  // And the P4's console, where a forwarded WIFI line came from (its lines end in "\n").
  char t[sizeof reply + 2];
  snprintf(t, sizeof t, "%s\n", reply);
  frontend_link_log(t);
}

void setup() {
  Serial.begin(115200);
  // The console's TX is non-blocking (the log drain task writes it): a disconnected
  // console never stalls the loop.
  Serial.setTxTimeoutMs(100);
  log_drain_start();
  // Flash auto-suspend (D-459) before anything writes the flash: a littlefs erase (the mesh
  // state, the TLS identity) then never stalls the SDIO slave or the netstack (code keeps
  // running from flash). Only on the flash it was measured on; the stock lock otherwise.
  uint32_t jedec = 0;
  const int fsus = lm_flash_auto_suspend_enable(&jedec);
  // This front end runs the mesh layer: the P4's Welcome says "mesh" (LK_FE_MESH).
  frontend_link_set_features(LK_FE_MESH);
  // The SDIO slave first: the P4 probes for this front end as soon as it boots.
  frontend_link_begin();
  // The mesh's wss connection ends with its owner's session (mesh_app); the link's own
  // handler (LK_OP_RESET to the P4) runs first.
  g_session_closed_next = netstack_session_closed;
  netstack_session_closed = [](uint16_t session) {
    if (g_session_closed_next) g_session_closed_next(session);
    if (session == g_mesh_ws_owner) g_mesh_ws_closed = true;
  };
  Log().printf("[boot] reset_reason=%d relay %s (%s%s)\n", (int)esp_reset_reason(), LM_VERSION,
               LM_GIT_COMMIT_SHORT, LM_GIT_DIRTY ? "-dirty" : "");
  // OTA (docs/design/ota.md): crash-loop guard + the health deadline of a fresh install.
  ota_app_boot();
  Log().printf("[flash] auto-suspend %s jedec=%06lx\n", fsus == LM_FLASH_SUSPEND_ON ? "on" : "off",
               (unsigned long)jedec);
  g_fs_ok = fs_mount();
  if (!g_fs_ok) Log().printf("[relay] littlefs mount failed: the TLS identity is RAM-only\n");
  g_prefs.begin("ledmapper");
  identity_begin();
  Log().printf("[relay] identity %s / \"%s\"\n", g_mac, g_name);
  String ssid = g_prefs.getString("ssid", "");
  // BLE Improv before the netstack: the BT controller has to init before the netstack
  // takes over the MAC, so our radio config wins.
  improv_ble_begin(g_name, ssid.length() > 0 ? IMPROV_STATE_PROVISIONING : IMPROV_STATE_AUTHORIZED);
  // This device's TLS identity, loaded or generated now (before a lease exists).
  device_cert_begin(g_mac, g_fs_ok ? &kTlsStore : nullptr);
  netstack_restore_credentials(ssid.c_str(), g_prefs.getString("pass", "").c_str());
  wifi_policy_begin();
  netstack_setup();
  vTaskPrioritySet(nullptr, kLoopPrio);
  log_status();
}

void loop() {
  {
    const uint32_t f = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (f < g_heap_window_min) g_heap_window_min = f;
  }
  netstack_loop();  // RX drain + DHCP + BLE-Improv join + TLS/WS pump (dispatches here)
  frontend_link_poll();
  poll_mesh_sessions();
  poll_wifi_policy();
  {
    // OTA health: nothing renders here, so "alive" is the loop itself. Offline / manual
    // (outside a join window): the board isn't supposed to reach a network, so a fresh
    // update is judged without it (wifi-rejoin-policy.md "OTA").
    const bool wants_net = netstack_wifi_wants_network();
    ota_app_poll(true, device_cert_ready() || !wants_net, netstack_leased() || !wants_net);
  }
  static uint32_t last_report = 0;
  if (millis() - last_report > 5000) {
    last_report = millis();
    log_status();
  }
  delay(1);
}
