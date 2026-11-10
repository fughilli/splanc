// Firmware update for the ESP32-P4 player (docs/design/p4-c6-split.md §5.1): the P4 takes
// its own image, in the app, while it keeps rendering. There is no loader: the C6 front end
// stays reachable whatever the P4 runs, which is the job the loader does on a C6.
//
// One package updates BOTH chips. The P4 image carries the C6 front end's images
// (//firmware/p4/c6flash), and at boot the P4 reflashes the C6 whenever the C6 runs
// anything else (link_transport.cpp). So:
//   ota_begin (signed manifest, board 16) -> ota_chunk... into the slot not running ->
//   ota_finish (read-back SHA-256 + image check) -> select it, restart -> the new P4
//   boots pending verify, flashes its C6 images onto the C6 -> healthy (renders, and the
//   link is up to a C6 running the image this P4 carries) -> marked valid.
// A new P4 that crashes, hangs (RTC watchdog) or isn't healthy by the deadline is rolled
// back by the IDF bootloader; the old P4 then finds the new C6 image and puts its own back.
//
// The C6 forwards the OTA arms here (main.cpp, LM_FRONTEND). The decisions (offer
// checks, session bookkeeping, key epochs, the health verdict, the wire) are the
// host-tested Rust core (firmware/ota) the C6 loader uses; this file is the glue.
#include <Arduino.h>
#include <Preferences.h>
#include <esp_image_format.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <hal/rwdt_ll.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/sha256.h>
#include <soc/rtc.h>
#include <stdarg.h>
#include <string.h>

#include "firmware/loader/ota_kat.h"
#include "firmware/ota/ota_ffi.h"
#include "firmware/ota/ota_key.h"
#include "firmware/player_app/build_info.h"
#include "firmware/player_app/ota_app.h"
#include "firmware/player_app/serial_log.h"
#include "netstack_transport.h"

// link_transport.cpp: the link is up to a C6 running the front-end image this P4 carries.
bool link_c6_current();

// Arduino's initArduino() marks a pending app valid at boot unless this says the app
// will decide later. It will: ota_app_poll, once healthy.
extern "C" bool verifyRollbackLater() { return true; }

namespace {

// The same namespace as the C6 (docs/design/ota.md "State"), with the P4's own keys.
// The health deadline and the RTC watchdog are the C6's (OTA_HEALTH_DEADLINE_MS,
// OTA_WATCHDOG_MS): the first boot of a new pair reflashes the C6 before the link comes
// up, well inside both.
constexpr const char *kOtaNs = "splanc_ota";

Preferences g_ota;
bool g_nvs = false;
const esp_partition_t *g_running = nullptr;
const esp_partition_t *g_next = nullptr;  // the slot an update goes to (never the running one)
bool g_pending = false;                   // this boot is a fresh install, pending verify
uint32_t g_restart_at = 0;                // a reply is in flight; restart then (0 = none)
uint32_t g_app_version = 0;               // manifest version of the running image (0 unknown)
bool g_version_checked = false;
char g_last[24] = "";
const char *g_error = nullptr;  // the last refusal, reported until the next request
OtaKeyStateC g_keys = {};
int g_crypto_ok = -1;  // known-answer self-test: -1 not run yet

void log_line(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void log_line(const char *fmt, ...) {
  char buf[200];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  Log().printf("[ota] %s\n", buf);
}

// Per-slot records ("v_<label>", "n_<label>", "s_<label>"): what the receiver wrote into
// that slot, so the image running there can tell whether it is still that image (a USB
// flash since makes its version unknown).
void slot_key(char *out, size_t cap, char kind, const esp_partition_t *p) {
  snprintf(out, cap, "%c_%s", kind, p->label);
}

void set_last(const char *r) {
  strncpy(g_last, r, sizeof g_last - 1);
  g_last[sizeof g_last - 1] = 0;
  if (g_nvs) g_ota.putString("last", g_last);
}

// -- the watchdog -----------------------------------------------------------------------

// The RTC (LP) watchdog: independent of the CPUs and every task, so a pending image that
// hangs anywhere still resets, and a reset while pending verify rolls back.
void arm_health_deadline(uint32_t ms) {
  rwdt_dev_t *hw = RWDT_DEV_GET();
  uint32_t ticks = (uint32_t)((uint64_t)ms * rtc_clk_slow_freq_get_hz() / 1000);
  rwdt_ll_write_protect_disable(hw);
  rwdt_ll_disable(hw);
  rwdt_ll_set_flashboot_en(hw, false);
  rwdt_ll_set_sys_reset_length(hw, WDT_RESET_SIG_LENGTH_3_2us);
  rwdt_ll_set_cpu_reset_length(hw, WDT_RESET_SIG_LENGTH_3_2us);
  rwdt_ll_config_stage(hw, WDT_STAGE0, ticks, WDT_STAGE_ACTION_RESET_RTC);
  rwdt_ll_disable_stage(hw, WDT_STAGE1);
  rwdt_ll_disable_stage(hw, WDT_STAGE2);
  rwdt_ll_disable_stage(hw, WDT_STAGE3);
  rwdt_ll_feed(hw);
  rwdt_ll_enable(hw);
  rwdt_ll_write_protect_enable(hw);
}

void disarm_health_deadline() {
  rwdt_dev_t *hw = RWDT_DEV_GET();
  rwdt_ll_write_protect_disable(hw);
  rwdt_ll_disable(hw);
  rwdt_ll_write_protect_enable(hw);
}

// -- signatures (as the C6 loader, loader_main.cpp) -------------------------------------

bool p256_verify(const uint8_t pub[65], const uint8_t *msg, size_t len, const uint8_t sig[64]) {
  uint8_t hash[32];
  if (mbedtls_sha256(msg, len, hash, 0) != 0) return false;
  mbedtls_ecp_group grp;
  mbedtls_ecp_point q;
  mbedtls_mpi r, s;
  mbedtls_ecp_group_init(&grp);
  mbedtls_ecp_point_init(&q);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
  if (rc == 0) rc = mbedtls_ecp_point_read_binary(&grp, &q, pub, 65);
  if (rc == 0) rc = mbedtls_mpi_read_binary(&r, sig, 32);
  if (rc == 0) rc = mbedtls_mpi_read_binary(&s, sig + 32, 32);
  if (rc == 0) rc = mbedtls_ecdsa_verify(&grp, hash, sizeof hash, &q, &r, &s);
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_ecp_point_free(&q);
  mbedtls_ecp_group_free(&grp);
  return rc == 0;
}

// A good signature must verify and a flipped bit must not, so a broken verifier can't
// silently accept (or refuse) everything.
bool crypto_ok() {
  if (g_crypto_ok < 0) {
    bool good = p256_verify(ota_kat::kPublic, ota_kat::kSigned, sizeof ota_kat::kSigned, ota_kat::kSignature);
    uint8_t bad[64];
    memcpy(bad, ota_kat::kSignature, 64);
    bad[7] ^= 1;
    bool refused = !p256_verify(ota_kat::kPublic, ota_kat::kSigned, sizeof ota_kat::kSigned, bad);
    g_crypto_ok = good && refused;
    log_line("signature self-test %s", g_crypto_ok ? "ok" : "FAILED: refusing updates");
  }
  return g_crypto_ok == 1;
}

const ota_key::Key *ring_key(uint8_t id) {
  for (int i = 0; i < ota_key::kRingLen; i++)
    if (ota_key::kRing[i].id == id && ota_key::kRing[i].has) return &ota_key::kRing[i];
  return nullptr;
}

void save_key_state(const OtaKeyStateC &k) {
  // Never lowered (the core refuses a record that would), written before use.
  g_ota.putUInt("kepoch", k.epoch);
  g_ota.putUInt("krevoked", k.revoked);
  g_ota.putUChar("sfloor", k.security_floor);
  g_keys = k;
}

const char *apply_key_epoch(const uint8_t *p, size_t len) {
  OtaEpochC e;
  if (!ota_epoch_parse(p, len, &e)) return "bad_epoch";
  const ota_key::Key *k = ring_key(e.signer);
  bool sig = k && p256_verify(k->pub, e.signed_bytes, sizeof e.signed_bytes, e.signature);
  OtaKeyStateC next;
  const char *err = ota_epoch_apply(&g_keys, p, len, sig, ota_key::kRingMask, &next);
  if (err != nullptr && strcmp(err, "stale_epoch") == 0) return nullptr;
  if (err != nullptr) return err;
  save_key_state(next);
  log_line("key epoch %lu accepted (signed by key %u): revoked=0x%lx", (unsigned long)next.epoch, e.signer,
           (unsigned long)next.revoked);
  return nullptr;
}

// The manifest's ring key (its id, not revoked, at/above the security floor) and the
// signature with it. Null on success.
const char *check_manifest(const uint8_t *m, size_t len) {
  OtaManifestC mc;
  if (!ota_manifest_parse(m, len, &mc)) return "bad_manifest";
  uint8_t id = 0;
  if (const char *err = ota_key_select(m, len, ota_key::kRingMask, &g_keys, &id)) return err;
  const ota_key::Key *k = ring_key(id);
  if (!k || !p256_verify(k->pub, mc.signed_bytes, sizeof mc.signed_bytes, mc.signature)) return "bad_signature";
  return nullptr;
}

// -- slots ------------------------------------------------------------------------------

// SHA-256 of the first `size` bytes of `p`.
bool slot_sha256(const esp_partition_t *p, uint32_t size, uint8_t out[32]) {
  constexpr uint32_t kChunk = 4096;
  uint8_t *buf = static_cast<uint8_t *>(malloc(kChunk));
  if (!buf) return false;
  mbedtls_sha256_context h;
  mbedtls_sha256_init(&h);
  bool ok = mbedtls_sha256_starts(&h, 0) == 0;
  for (uint32_t off = 0; ok && off < size; off += kChunk) {
    uint32_t n = size - off < kChunk ? size - off : kChunk;
    ok = esp_partition_read(p, off, buf, n) == ESP_OK && mbedtls_sha256_update(&h, buf, n) == 0;
  }
  ok = ok && mbedtls_sha256_finish(&h, out) == 0;
  mbedtls_sha256_free(&h);
  free(buf);
  return ok;
}

// The running image's manifest version: what the receiver recorded for this slot, if the
// slot still holds that image. Checked once, lazily (hashing 3 MB takes a moment).
uint32_t app_version() {
  if (g_version_checked || !g_nvs || !g_running) return g_app_version;
  g_version_checked = true;
  char kv[16], kn[16], ks[16];
  slot_key(kv, sizeof kv, 'v', g_running);
  slot_key(kn, sizeof kn, 'n', g_running);
  slot_key(ks, sizeof ks, 's', g_running);
  uint32_t v = g_ota.getUInt(kv, 0), size = g_ota.getUInt(kn, 0);
  uint8_t want[32], got[32];
  if (v == 0 || size == 0 || size > g_running->size || g_ota.getBytes(ks, want, sizeof want) != sizeof want) return 0;
  g_app_version = slot_sha256(g_running, size, got) && memcmp(got, want, 32) == 0 ? v : 0;
  log_line("%s holds manifest v%lu? %s", g_running->label, (unsigned long)v,
           g_app_version ? "yes" : "no: USB-flashed or changed");
  return g_app_version;
}

// The resume record names a slot too: a transfer only resumes into the slot it started in.
bool load_job(uint8_t rec[OTA_RESUME_LEN]) {
  char slot[17] = "";
  if (!g_nvs || !g_next) return false;
  g_ota.getString("job_slot", slot, sizeof slot);
  return strcmp(slot, g_next->label) == 0 && g_ota.getBytes("job", rec, OTA_RESUME_LEN) == OTA_RESUME_LEN;
}

void save_job() {
  uint8_t rec[OTA_RESUME_LEN];
  if (ota_session_resume_record(rec)) g_ota.putBytes("job", rec, sizeof rec);
}

void forget_job() {
  g_ota.remove("job");
  g_ota.remove("job_slot");
}

// -- status -----------------------------------------------------------------------------

int reply_status(uint8_t state, uint8_t *out, size_t cap) {
  OtaStatusC s;
  memset(&s, 0, sizeof s);
  s.mode = OTA_MODE_APP;
  s.state = state;
  if (ota_session_active()) {
    s.version = ota_session_version();
    s.size = ota_session_size();
    s.offset = ota_session_offset();
  } else {
    uint8_t rec[OTA_RESUME_LEN];
    if (load_job(rec)) ota_resume_info(rec, sizeof rec, &s.version, &s.size, &s.offset);
  }
  s.error = g_error;
  s.app_version = app_version();
  s.app_fw_version = LM_VERSION;
  s.loader_reason = "";
  s.last_result = g_last;
  s.max_chunk = OTA_MAX_CHUNK;
  s.slot_size = g_next ? g_next->size : 0;
  s.key_epoch = g_keys.epoch;
  s.revoked_keys = g_keys.revoked;
  s.security_floor = g_keys.security_floor;
  return (int)ota_encode_status(&s, out, cap);
}

int refuse(const char *code, uint8_t *out, size_t cap) {
  g_error = code;
  log_line("refused: %s", code);
  return reply_status(OTA_STATE_FAILED, out, cap);
}

// -- the arms ---------------------------------------------------------------------------

int on_begin(const uint8_t *frame, const OtaClientMsg &m, uint8_t *out, size_t cap) {
  if (!g_nvs || !g_next) return refuse("legacy_layout", out, cap);  // the one-time USB migration
  if (g_pending) return refuse("busy", out, cap);  // this image hasn't proved itself yet
  if (!crypto_ok()) return refuse("bad_signature", out, cap);
  if (m.epoch_len > 0) {
    if (const char *err = apply_key_epoch(frame + m.epoch_off, m.epoch_len)) return refuse(err, out, cap);
  }
  const uint8_t *mf = frame + m.manifest_off;
  const char *key_err = check_manifest(mf, m.manifest_len);
  if (key_err != nullptr && strcmp(key_err, "bad_signature") != 0) return refuse(key_err, out, cap);
  uint8_t rec[OTA_RESUME_LEN];
  const bool resume = load_job(rec);
  // The chip id picks the board the core accepts: P4 player images only (board 16).
  const char *err = ota_session_begin(mf, m.manifest_len, key_err == nullptr, g_next->size, OTA_CHIP_ESP32P4,
                                      app_version(), m.allow_downgrade, resume ? rec : nullptr,
                                      resume ? sizeof rec : 0);
  if (err != nullptr) return refuse(err, out, cap);
  // Persist the session before the first erase, so a dropped link or a power cut resumes.
  if (!ota_session_resume_record(rec) || g_ota.putBytes("job", rec, sizeof rec) != sizeof rec ||
      g_ota.putString("job_slot", g_next->label) == 0) {
    ota_session_reset();
    return refuse("flash_error", out, cap);
  }
  g_error = nullptr;
  log_line("begin version=%lu size=%lu into %s at offset %lu", (unsigned long)ota_session_version(),
           (unsigned long)ota_session_size(), g_next->label, (unsigned long)ota_session_offset());
  return reply_status(OTA_STATE_RECEIVING, out, cap);
}

int on_chunk(const uint8_t *frame, const OtaClientMsg &m, uint8_t *out, size_t cap) {
  OtaPlanC p;
  const char *err = ota_session_plan(m.offset, frame + m.data_off, m.data_len, OTA_CHIP_ESP32P4, &p);
  if (err != nullptr) {
    // out_of_order keeps the session: ota_status.offset says where to resume.
    if (strcmp(err, "bad_image") == 0 || strcmp(err, "wrong_chip") == 0) ota_session_reset();
    return refuse(err, out, cap);
  }
  if (p.erase_len > 0 && esp_partition_erase_range(g_next, p.erase_off, p.erase_len) != ESP_OK)
    return refuse("flash_error", out, cap);
  if (esp_partition_write(g_next, p.write_at, frame + m.data_off, p.len) != ESP_OK)
    return refuse("flash_error", out, cap);
  if (ota_session_commit(&p)) save_job();
  g_error = nullptr;
  return reply_status(OTA_STATE_RECEIVING, out, cap);
}

int on_finish(uint8_t *out, size_t cap) {
  if (const char *err = ota_session_finish_ready()) return refuse(err, out, cap);
  uint8_t want[32], got[32];
  ota_session_sha256(want);
  const uint32_t size = ota_session_size(), v = ota_session_version(), t0 = millis();
  const bool hash_ok = slot_sha256(g_next, size, got) && memcmp(got, want, 32) == 0;
  esp_partition_pos_t pos = {g_next->address, g_next->size};
  esp_image_metadata_t md = {};
  const bool image_ok = hash_ok && esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &pos, &md) == ESP_OK;
  log_line("verify %s: sha256=%s image=%s (%lu ms)", g_next->label, hash_ok ? "ok" : "MISMATCH",
           image_ok ? "ok" : "BAD", (unsigned long)(millis() - t0));
  if (!image_ok) {
    forget_job();  // start over: the bytes on flash aren't the signed image
    ota_session_reset();
    set_last("verify_failed");
    return refuse("verify_failed", out, cap);
  }
  {
    // Installing it raises the security floor (never lowered).
    uint8_t rec[OTA_RESUME_LEN];
    if (ota_session_resume_record(rec)) {
      OtaKeyStateC k = g_keys;
      k.security_floor = ota_floor_after(&g_keys, rec, OTA_MANIFEST_LEN);
      if (k.security_floor != g_keys.security_floor) save_key_state(k);
    }
  }
  char kv[16], kn[16], ks[16];
  slot_key(kv, sizeof kv, 'v', g_next);
  slot_key(kn, sizeof kn, 'n', g_next);
  slot_key(ks, sizeof ks, 's', g_next);
  g_ota.putUInt(kv, v);
  g_ota.putUInt(kn, size);
  g_ota.putBytes(ks, want, sizeof want);
  if (esp_ota_set_boot_partition(g_next) != ESP_OK) {
    ota_session_reset();
    return refuse("flash_error", out, cap);
  }
  // Cleared by the new image once it proves healthy; a rollback finds it still set.
  g_ota.putString("pending", g_next->label);
  forget_job();
  set_last("installed");
  g_error = nullptr;
  const int n = reply_status(OTA_STATE_INSTALLED, out, cap);
  ota_session_reset();
  g_restart_at = millis() + 400;  // once the reply is on its way through the C6
  if (g_restart_at == 0) g_restart_at = 1;
  log_line("installed v%lu in %s: restarting into it", (unsigned long)v, g_next->label);
  return n;
}

}  // namespace

void ota_app_boot() {
  g_running = esp_ota_get_running_partition();
  g_next = esp_ota_get_next_update_partition(nullptr);
  if (g_next && g_running && g_next->address == g_running->address) g_next = nullptr;
  g_nvs = g_ota.begin(kOtaNs, false);
  if (g_nvs) {
    g_ota.getString("last", g_last, sizeof g_last);
    g_keys.epoch = g_ota.getUInt("kepoch", 0);
    g_keys.revoked = g_ota.getUInt("krevoked", 0);
    g_keys.security_floor = g_ota.getUChar("sfloor", 0);
  }
  esp_ota_img_states_t st;
  g_pending = g_running && esp_ota_get_state_partition(g_running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
  if (g_pending) arm_health_deadline(OTA_WATCHDOG_MS);
  if (g_nvs && !g_pending) {
    // An install that never proved itself: the bootloader brought back the other slot.
    char pending[17] = "";
    g_ota.getString("pending", pending, sizeof pending);
    if (pending[0] && g_running && strcmp(pending, g_running->label) != 0) {
      set_last("rolled_back");
      log_line("the update in %s didn't prove healthy: rolled back to %s", pending, g_running->label);
    }
    if (pending[0]) g_ota.remove("pending");
  }
  log_line("layout=%s running=%s next=%s pending=%d last=%s", g_next ? "a/b" : "single-slot",
           g_running ? g_running->label : "-", g_next ? g_next->label : "-", g_pending, g_last);
}

bool ota_app_pending() { return g_pending; }

void ota_app_poll(bool render_alive, bool, bool) {
  const uint32_t now = millis();
  if (g_restart_at != 0 && (int32_t)(now - g_restart_at) >= 0) {
    g_restart_at = 0;
    delay(50);
    esp_restart();
  }
  if (!g_pending) return;
  // Healthy = it renders, and the link is up to a C6 running the front-end image this P4
  // carries: the pair it ships with is in place and can take the next update. A pair
  // that can't get there in time goes back to the previous one.
  OtaHealthC h = {now, render_alive, link_c6_current(), true, netstack_leased()};
  const char *why = nullptr;
  const uint8_t v = ota_health(&h, &why);
  if (v == 1) {
    g_pending = false;
    esp_ota_mark_app_valid_cancel_rollback();
    disarm_health_deadline();
    if (g_nvs) g_ota.remove("pending");
    set_last("ok");
    log_line("healthy after %lu ms: marked valid", (unsigned long)now);
  } else if (v == 2) {
    const char *what = why == nullptr                ? "?"
                       : strcmp(why, "tls") == 0     ? "the C6 isn't running this image's front end"
                       : strcmp(why, "network") == 0 ? "no link to the C6"
                                                     : why;
    log_line("not healthy by the deadline (%s): rolling back", what);
    delay(100);
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}

int ota_app_dispatch(const uint8_t *msg, size_t len, uint8_t *out, size_t cap) {
  OtaClientMsg m;
  if (ota_parse_client(msg, len, &m) != 0) return 0;  // let the player answer it
  switch (m.arm) {
    case OTA_ARM_GET_STATUS:
      return reply_status(ota_session_active() ? OTA_STATE_RECEIVING : OTA_STATE_IDLE, out, cap);
    case OTA_ARM_BEGIN:
      return on_begin(msg, m, out, cap);
    case OTA_ARM_CHUNK:
      return on_chunk(msg, m, out, cap);
    case OTA_ARM_FINISH:
      return on_finish(out, cap);
    case OTA_ARM_ABORT:
      // The slot keeps what arrived (and the resume record): the same manifest resumes.
      ota_session_reset();
      g_error = nullptr;
      return reply_status(OTA_STATE_IDLE, out, cap);
    case OTA_ARM_REBOOT:
      if (m.target == 1) return refuse("no_loader", out, cap);  // the P4 has none (§5.1)
      g_restart_at = millis() + 400;
      return reply_status(OTA_STATE_REBOOTING, out, cap);
    default:
      return 0;
  }
}
