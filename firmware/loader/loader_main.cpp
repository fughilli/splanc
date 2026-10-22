// Splanc loader: the small app in the factory slot that owns firmware updates
// (docs/design/ota.md). Rarely changed and never overwritten over the air, so a
// bad player image can't strand a fixture.
//
// Boot (the IDF bootloader only gets us here when otadata doesn't select a
// healthy app: the app handed over for an update, it was rolled back, or the
// slot is empty):
//   decide (firmware/ota boot.rs loader_decide) from the app slot's state, the
//   resume record, the app's handoff note and the reset reason:
//   - boot the app (select ota_0 -> it boots pending verify), or
//   - retry an app the power cut rolled back (once), or
//   - recovery: join the network with the stored credentials (BLE Improv
//     provisioning if there are none), serve wss :443 with the device's own TLS
//     identity, and take an image: ota_begin (signed manifest) -> ota_chunk... ->
//     ota_finish (read-back SHA-256 against the manifest) -> select the app,
//     restart. Every chunk is written in place into the app slot; the resume
//     record (manifest + offset, NVS) makes a dropped link or a power cut resume.
//
// The transport is the player's own heapless netstack (//firmware/player_app:
// netstack_transport); this file provides its lm_* seam with an OTA-only
// dispatch (firmware/ota wire.rs): hello -> a Welcome with ota.mode = LOADER,
// the OTA arms, and error{unsupported} for everything else.
#include <Arduino.h>
#include <Preferences.h>
#include <esp_image_format.h>
#include <esp_littlefs.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_flash.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/sha256.h>
#include <stdio.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "firmware/loader/build_info.h"
#include "device_cert.h"
#include "firmware/ota/ota_ffi.h"
#include "firmware/ota/ota_key.h"
#include "improv_ble.h"
#include "improv_codec.h"
#include "netstack_transport.h"
#include "firmware/loader/ota_kat.h"

extern "C" {
void loader_set_identity(const char *mac, const char *name, const char *version);
int32_t loader_mdns_respond(const uint8_t *query, size_t qlen, uint16_t src_port,
                            const uint8_t *ip, uint8_t *out, size_t cap, bool *unicast);
int32_t loader_mdns_announce(const uint8_t *ip, uint8_t *out, size_t cap);
}

namespace {

constexpr const char *kFsBase = "/lfs";
constexpr const char *kFsPartition = "spiffs";
constexpr const char *kTlsIdentityPath = "/lfs/tls_id.bin";
constexpr const char *kOtaNs = "splanc_ota";  // keys: see docs/design/ota.md "State"
constexpr uint32_t kReturnAfterRefusalMs = 30 * 1000;

Preferences g_ota;
bool g_fs_ok = false;
const esp_partition_t *g_app = nullptr;
bool g_app_bootable = false;
uint32_t g_app_version = 0;     // NVS app_ver: the manifest version installed (0 unknown)
const char *g_reason = "";      // loader_reason
char g_last[24] = "";           // last_result
uint32_t g_loader_version = 0;  // ota_parse_version(LM_VERSION)
uint32_t g_idle_deadline = 0;   // millis() at which an idle recovery returns to the app (0: never)
uint32_t g_restart_at = 0;      // a reply is in flight; restart (into the selected app) then
bool g_restart_pending = false;
char g_mac[18];
char g_name[33];
// The last refusal, reported in ota_status.error until the next request.
const char *g_error = nullptr;

// One reply buffer for wss and BLE, with the WS header headroom the transport writes
// in place (netstack_transport.h kWsSendHeadroom).
struct {
  uint8_t headroom[16];
  uint8_t data[1024];
} g_tx;
static_assert(sizeof g_tx.headroom >= kWsSendHeadroom, "tx needs WS header headroom");

char g_tls_state[16] = "";
char g_cert_sha[65] = "";
bool g_tls_persisted = false;

void log_line(const char *fmt, ...) {
  char buf[200];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  Serial.printf("[t=%lu] [loader] %s\n", (unsigned long)millis(), buf);
}

uint8_t reset_class() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
    case ESP_RST_EXT:
    case ESP_RST_USB:  // the USB-serial host reset the chip: external, like EN
      return 0;
    case ESP_RST_BROWNOUT:
      return 1;
    case ESP_RST_SW:
      return 2;
    case ESP_RST_PANIC:
      return 3;
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:
      return 4;
    default:
      return 5;
  }
}

// -- the app slot ---------------------------------------------------------------------

// Full bootloader-level check of the slot (header, segments, appended SHA-256).
bool app_image_valid() {
  if (g_app == nullptr) return false;
  esp_partition_pos_t pos = {g_app->address, g_app->size};
  esp_image_metadata_t md = {};
  return esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &pos, &md) == ESP_OK;
}

// 0 missing, 1 bootable, 2 aborted, 3 invalid (OtaLoaderInputsC.app).
uint8_t app_state() {
  if (!app_image_valid()) return 0;
  esp_ota_img_states_t st;
  if (esp_ota_get_state_partition(g_app, &st) == ESP_OK) {
    if (st == ESP_OTA_IMG_ABORTED) return 2;
    if (st == ESP_OTA_IMG_INVALID) return 3;
  }
  return 1;
}

// Select the app (it boots pending verify) and restart. `network` tells the app's
// health check whether we were on the network (then it must get there too).
[[noreturn]] void boot_app(bool network) {
  g_ota.putUChar("net", network ? 1 : 0);
  esp_err_t e = esp_ota_set_boot_partition(g_app);
  log_line("booting the app (set_boot_partition=%d)", (int)e);
  Serial.flush();
  netstack_prepare_restart();  // keep the MAC (and so the IP) for the app
  delay(50);
  esp_restart();
}

void set_last(const char *r) {
  strncpy(g_last, r, sizeof g_last - 1);
  g_last[sizeof g_last - 1] = 0;
  g_ota.putString("last", g_last);
}

// -- signatures -----------------------------------------------------------------------

// ECDSA P-256 over SHA-256 of the manifest's signed bytes, against `pub` (65-byte
// SEC1 uncompressed). mbedtls with the C6's ECDSA-verify/SHA accelerators.
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

// The keyring (docs/design/ota.md "Key rotation"): the compiled-in keys, by id, and
// the persisted key state (accepted epoch, revoked ids, security-version floor).
const ota_key::Key *ring_key(uint8_t id) {
  for (int i = 0; i < ota_key::kRingLen; i++)
    if (ota_key::kRing[i].id == id && ota_key::kRing[i].has) return &ota_key::kRing[i];
  return nullptr;
}

OtaKeyStateC g_keys = {};

void load_key_state() {
  g_keys.epoch = g_ota.getUInt("kepoch", 0);
  g_keys.revoked = g_ota.getUInt("krevoked", 0);
  g_keys.security_floor = g_ota.getUChar("sfloor", 0);
}

void save_key_state(const OtaKeyStateC &k) {
  // Never lowered (the core refuses a record that would), written before use.
  g_ota.putUInt("kepoch", k.epoch);
  g_ota.putUInt("krevoked", k.revoked);
  g_ota.putUChar("sfloor", k.security_floor);
  g_keys = k;
}

// Apply a key-epoch record that rode in with ota_begin. Null = applied, or already
// known (not newer); else the refusal.
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
  log_line("key epoch %lu accepted (signed by key %u): revoked=0x%lx", (unsigned long)next.epoch,
           e.signer, (unsigned long)next.revoked);
  return nullptr;
}

// Pick the manifest's ring key (its key id, not revoked, at/above the security floor)
// and verify the signature with it. Null on success.
const char *check_manifest(const uint8_t *m, size_t len) {
  OtaManifestC mc;
  if (!ota_manifest_parse(m, len, &mc)) return "bad_manifest";
  uint8_t id = 0;
  if (const char *err = ota_key_select(m, len, ota_key::kRingMask, &g_keys, &id)) return err;
  const ota_key::Key *k = ring_key(id);
  if (!k || !p256_verify(k->pub, mc.signed_bytes, sizeof mc.signed_bytes, mc.signature)) {
    return "bad_signature";
  }
  return nullptr;
}

// Known answers (ota_kat.h, signed by the test key): a good signature must verify and
// a flipped bit must not, so a broken verifier can't silently accept or refuse all.
bool crypto_self_test() {
  bool good = p256_verify(ota_kat::kPublic, ota_kat::kSigned, sizeof ota_kat::kSigned,
                          ota_kat::kSignature);
  uint8_t bad[64];
  memcpy(bad, ota_kat::kSignature, 64);
  bad[7] ^= 1;
  bool refused = !p256_verify(ota_kat::kPublic, ota_kat::kSigned, sizeof ota_kat::kSigned, bad);
  return good && refused;
}

// -- status ---------------------------------------------------------------------------

void fill_status(OtaStatusC *s, uint8_t state) {
  memset(s, 0, sizeof *s);
  s->mode = OTA_MODE_LOADER;
  s->state = state;
  if (ota_session_active()) {
    s->version = ota_session_version();
    s->size = ota_session_size();
    s->offset = ota_session_offset();
  } else {
    // A transfer a power cut or a dropped link left behind (resume it with the same
    // manifest).
    uint8_t rec[OTA_RESUME_LEN];
    if (g_ota.getBytes("job", rec, sizeof rec) == sizeof rec) {
      ota_resume_info(rec, sizeof rec, &s->version, &s->size, &s->offset);
    }
  }
  s->error = g_error;
  s->app_version = g_app_bootable ? g_app_version : 0;
  s->app_fw_version = "";
  s->loader_reason = g_reason;
  s->last_result = g_last;
  s->loader_version = g_loader_version;
  s->max_chunk = OTA_MAX_CHUNK;
  s->slot_size = g_app ? g_app->size : 0;
  s->key_epoch = g_keys.epoch;
  s->revoked_keys = g_keys.revoked;
  s->security_floor = g_keys.security_floor;
}

int reply_status(uint8_t state) {
  OtaStatusC s;
  fill_status(&s, state);
  return (int)ota_encode_status(&s, g_tx.data, sizeof g_tx.data);
}

int reply_refusal(const char *code) {
  g_error = code;
  log_line("refused: %s", code);
  return reply_status(OTA_STATE_FAILED);
}

// -- the OTA arms ---------------------------------------------------------------------

// A refused offer during an update handoff: nothing was touched, so give the app back
// soon rather than after the full idle timeout.
int refuse_offer(const char *err) {
  if (!ota_session_active() && g_app_bootable && strcmp(g_reason, "update") == 0) {
    g_idle_deadline = millis() + kReturnAfterRefusalMs;
  }
  return reply_refusal(err);
}

int on_begin(const uint8_t *frame, const OtaClientMsg &m) {
  const uint8_t *mf = frame + m.manifest_off;
  if (m.epoch_len > 0) {
    if (const char *err = apply_key_epoch(frame + m.epoch_off, m.epoch_len)) return refuse_offer(err);
  }
  const char *key_err = check_manifest(mf, m.manifest_len);
  if (key_err != nullptr && strcmp(key_err, "bad_signature") != 0) return refuse_offer(key_err);
  bool sig = key_err == nullptr;
  uint8_t rec[OTA_RESUME_LEN];
  size_t rn = g_ota.getBytes("job", rec, sizeof rec);
  const char *err = ota_session_begin(mf, m.manifest_len, sig, g_app ? g_app->size : 0,
                                      OTA_CHIP_ESP32C6, g_app_bootable ? g_app_version : 0,
                                      m.allow_downgrade, rn == sizeof rec ? rec : nullptr,
                                      rn == sizeof rec ? rn : 0);
  if (err != nullptr) return refuse_offer(err);
  // Persist the session BEFORE the first erase: from here the slot may hold part of an
  // image, and a reboot must land back here (update_incomplete), not in a broken app.
  if (!ota_session_resume_record(rec) || g_ota.putBytes("job", rec, sizeof rec) != sizeof rec) {
    ota_session_reset();
    return reply_refusal("flash_error");
  }
  g_app_bootable = false;  // the slot is now the transfer's
  g_idle_deadline = 0;
  g_error = nullptr;
  log_line("begin version=%lu size=%lu at offset %lu", (unsigned long)ota_session_version(),
           (unsigned long)ota_session_size(), (unsigned long)ota_session_offset());
  return reply_status(OTA_STATE_RECEIVING);
}

int on_chunk(const uint8_t *frame, const OtaClientMsg &m) {
  OtaPlanC p;
  const char *err =
      ota_session_plan(m.offset, frame + m.data_off, m.data_len, OTA_CHIP_ESP32C6, &p);
  if (err != nullptr) {
    // out_of_order keeps the session: ota_status.offset says where to resume.
    if (strcmp(err, "bad_image") == 0 || strcmp(err, "wrong_chip") == 0) ota_session_reset();
    return reply_refusal(err);
  }
  if (p.erase_len > 0 && esp_partition_erase_range(g_app, p.erase_off, p.erase_len) != ESP_OK) {
    return reply_refusal("flash_error");
  }
  if (esp_partition_write(g_app, p.write_at, frame + m.data_off, p.len) != ESP_OK) {
    return reply_refusal("flash_error");
  }
  if (ota_session_commit(&p)) {
    uint8_t rec[OTA_RESUME_LEN];
    if (ota_session_resume_record(rec)) g_ota.putBytes("job", rec, sizeof rec);
  }
  g_error = nullptr;
  return reply_status(OTA_STATE_RECEIVING);
}

// Read the slot back through SHA-256 and compare with the signed digest.
bool slot_matches(uint32_t size, const uint8_t want[32]) {
  static uint8_t buf[4096];
  mbedtls_sha256_context h;
  mbedtls_sha256_init(&h);
  bool ok = mbedtls_sha256_starts(&h, 0) == 0;
  for (uint32_t off = 0; ok && off < size; off += sizeof buf) {
    uint32_t n = size - off < sizeof buf ? size - off : sizeof buf;
    ok = esp_partition_read(g_app, off, buf, n) == ESP_OK && mbedtls_sha256_update(&h, buf, n) == 0;
  }
  uint8_t got[32];
  ok = ok && mbedtls_sha256_finish(&h, got) == 0;
  mbedtls_sha256_free(&h);
  return ok && memcmp(got, want, 32) == 0;
}

int on_finish() {
  const char *err = ota_session_finish_ready();
  if (err != nullptr) return reply_refusal(err);
  uint8_t want[32];
  ota_session_sha256(want);
  uint32_t t0 = millis();
  bool hash_ok = slot_matches(ota_session_size(), want);
  bool image_ok = hash_ok && app_image_valid();
  log_line("verify sha256=%s image=%s (%lu ms)", hash_ok ? "ok" : "MISMATCH",
           image_ok ? "ok" : "BAD", (unsigned long)(millis() - t0));
  if (!image_ok) {
    // Start over: the bytes on flash aren't the signed image.
    g_ota.remove("job");
    ota_session_reset();
    set_last("verify_failed");
    return reply_refusal("verify_failed");
  }
  uint32_t v = ota_session_version();
  {
    // Installing it raises the security floor (never lowered): older images with a
    // lower security version can't be replayed onto this device afterwards.
    uint8_t rec[OTA_RESUME_LEN];
    if (ota_session_resume_record(rec)) {
      OtaKeyStateC k = g_keys;
      k.security_floor = ota_floor_after(&g_keys, rec, OTA_MANIFEST_LEN);
      if (k.security_floor != g_keys.security_floor) save_key_state(k);
    }
  }
  // What's in the slot, so the app can tell whether it is still this image (a USB
  // flash since makes its version unknown): version, size, and the signed digest.
  g_ota.putUInt("app_ver", v);
  g_ota.putUInt("app_size", ota_session_size());
  g_ota.putBytes("app_sha", want, sizeof want);
  g_ota.putUInt("pending", v);  // cleared by the app once it proves healthy
  g_ota.putUChar("retry", 0);
  g_ota.remove("job");
  set_last("installed");
  g_app_version = v;
  g_app_bootable = true;
  g_error = nullptr;
  int n = reply_status(OTA_STATE_INSTALLED);
  ota_session_reset();
  // Restart once the reply is on the wire.
  g_restart_pending = true;
  g_restart_at = millis() + 400;
  return n;
}

int dispatch(const uint8_t *in, size_t len) {
  OtaClientMsg m;
  if (ota_parse_client(in, len, &m) != 0) return -1;
  switch (m.arm) {
    case OTA_ARM_HELLO: {
      OtaStatusC s;
      fill_status(&s, ota_session_active() ? OTA_STATE_RECEIVING : OTA_STATE_IDLE);
      char ver[40];
      snprintf(ver, sizeof ver, "loader-%s", LM_VERSION);
      return (int)ota_encode_loader_welcome(g_mac, g_name, LM_GIT_COMMIT, LM_GIT_DIRTY != 0, ver,
                                            &s, g_tx.data, sizeof g_tx.data);
    }
    // The rest of a client's connect sequence (clock sync, the TLS pin check), so a
    // stock client reaches "connected" and can show the loader's status.
    case OTA_ARM_TIME_SYNC_PING: {
      double now = (double)millis();
      return (int)ota_encode_time_sync_pong(m.t0, now, now, g_tx.data, sizeof g_tx.data);
    }
    case OTA_ARM_GET_TLS_INFO:
      return (int)ota_encode_tls_info(g_tls_state, g_cert_sha, g_tls_persisted, g_tx.data,
                                      sizeof g_tx.data);
    case OTA_ARM_BEGIN:
      return on_begin(in, m);
    case OTA_ARM_CHUNK:
      return on_chunk(in, m);
    case OTA_ARM_FINISH:
      return on_finish();
    case OTA_ARM_ABORT:
      // The slot keeps whatever arrived (and the resume record): a later ota_begin with
      // the same manifest continues from there.
      ota_session_reset();
      g_error = nullptr;
      return reply_status(OTA_STATE_IDLE);
    case OTA_ARM_GET_STATUS:
      return reply_status(ota_session_active() ? OTA_STATE_RECEIVING : OTA_STATE_IDLE);
    case OTA_ARM_REBOOT: {
      if (m.target == 0) {
        if (!g_app_bootable || !app_image_valid()) return reply_refusal("no_app");
        g_ota.putUChar("handoff", OTA_HANDOFF_NONE);
      } else {
        g_ota.putUChar("handoff", OTA_HANDOFF_STAY);  // come back up in recovery
      }
      int n = reply_status(OTA_STATE_REBOOTING);
      g_restart_pending = true;
      g_restart_at = millis() + 400;
      return n;
    }
    default:
      return (int)ota_encode_error("unsupported", "the device is in its update loader",
                                   g_tx.data, sizeof g_tx.data);
  }
}

// -- littlefs (the TLS identity lives there) -------------------------------------------

size_t tls_store_read(uint8_t *buf, size_t cap) {
  FILE *f = fopen(kTlsIdentityPath, "rb");
  if (f == nullptr) return 0;
  size_t n = fread(buf, 1, cap, f);
  fclose(f);
  return n;
}

// Same temp + fsync + rename discipline as the app (main.cpp fs_write_file).
bool tls_store_write(const uint8_t *buf, size_t len) {
  char tmp[64];
  snprintf(tmp, sizeof tmp, "%s.tmp", kTlsIdentityPath);
  FILE *f = fopen(tmp, "wb");
  if (f == nullptr) return false;
  setvbuf(f, nullptr, _IONBF, 0);
  size_t w = fwrite(buf, 1, len, f);
  int s = fsync(fileno(f));
  fclose(f);
  if (w != len || s != 0) {
    remove(tmp);
    return false;
  }
  return rename(tmp, kTlsIdentityPath) == 0;
}

const DeviceCertStore kTlsStore = {tls_store_read, tls_store_write};

bool fs_mount(bool format) {
  esp_vfs_littlefs_conf_t conf = {};
  conf.base_path = kFsBase;
  conf.partition_label = kFsPartition;
  conf.format_if_mount_failed = format;
  return esp_vfs_littlefs_register(&conf) == ESP_OK;
}

// -- littlefs migration (docs/design/ota.md "Migration") ------------------------------
//
// The legacy huge_app layout kept littlefs at 0x310000/896K; this layout keeps it at
// OTA_PART_SPIFFS_* and puts the app slot over the old region. The USB migration
// writes only bootloader + table + otadata + loader (nothing at or past the old
// region), so on this first boot the old filesystem is intact: copy it across, then
// mark the new one (kMigratedMarker). Until the marker exists every boot re-runs the
// copy from a fresh format, so a power cut mid-copy just starts over. An app image
// always overwrites the old region's superblock (it is >1.25 MiB, the app slot's
// distance to 0x310000), so once an app is installed the old region never mounts.

constexpr uint32_t kLegacyFsOffset = 0x310000;
constexpr uint32_t kLegacyFsSize = 0xE0000;
constexpr const char *kLegacyBase = "/lfsold";
constexpr const char *kMigratedMarker = "/lfs/.ota_migrated";

esp_partition_t g_legacy_part;  // a hand-made view: the region overlaps the app slot

bool legacy_mount() {
  memset(&g_legacy_part, 0, sizeof g_legacy_part);
  g_legacy_part.flash_chip = esp_flash_default_chip;
  g_legacy_part.type = ESP_PARTITION_TYPE_DATA;
  g_legacy_part.subtype = ESP_PARTITION_SUBTYPE_DATA_SPIFFS;
  g_legacy_part.address = kLegacyFsOffset;
  g_legacy_part.size = kLegacyFsSize;
  g_legacy_part.erase_size = 4096;
  strcpy(g_legacy_part.label, "lfs_legacy");
  g_legacy_part.readonly = true;
  esp_vfs_littlefs_conf_t conf = {};
  conf.base_path = kLegacyBase;
  conf.partition = &g_legacy_part;
  conf.read_only = 1;
  conf.format_if_mount_failed = 0;
  return esp_vfs_littlefs_register(&conf) == ESP_OK;
}

// Copy every regular file in the legacy root across (the app keeps a flat namespace:
// map/topology/effect/pose/LUT/TLS identity/keypoints). Temp files are skipped.
int copy_legacy(int *failed) {
  int copied = 0;
  *failed = 0;
  DIR *d = opendir(kLegacyBase);
  if (d == nullptr) return 0;
  static uint8_t buf[2048];
  while (struct dirent *e = readdir(d)) {
    if (e->d_type != DT_REG) continue;
    size_t nl = strlen(e->d_name);
    if (nl > 4 && strcmp(e->d_name + nl - 4, ".tmp") == 0) continue;
    char src[96], dst[96];
    snprintf(src, sizeof src, "%s/%s", kLegacyBase, e->d_name);
    snprintf(dst, sizeof dst, "%s/%s", kFsBase, e->d_name);
    FILE *in = fopen(src, "rb");
    FILE *out = in ? fopen(dst, "wb") : nullptr;
    bool ok = in && out;
    size_t total = 0;
    while (ok) {
      size_t n = fread(buf, 1, sizeof buf, in);
      if (n == 0) break;
      ok = fwrite(buf, 1, n, out) == n;
      total += n;
    }
    if (out) ok = (fflush(out) == 0) && (fsync(fileno(out)) == 0) && ok;
    if (out) fclose(out);
    if (in) fclose(in);
    if (ok) {
      copied++;
      log_line("migrate: %s (%u B)", e->d_name, (unsigned)total);
    } else {
      (*failed)++;
      remove(dst);
      log_line("migrate: %s FAILED", e->d_name);
    }
  }
  closedir(d);
  return copied;
}

bool fs_prepare() {
  bool mounted = fs_mount(false);
  struct stat st;
  if (mounted && stat(kMigratedMarker, &st) == 0) return true;
  bool legacy = legacy_mount();
  if (!mounted || legacy) {
    // Fresh partition, or a copy a reset interrupted: start from a clean format.
    if (mounted) esp_vfs_littlefs_unregister(kFsPartition);
    esp_littlefs_format(kFsPartition);
    mounted = fs_mount(false);
  }
  if (!mounted) {
    if (legacy) esp_vfs_littlefs_unregister_partition(&g_legacy_part);
    log_line("migrate: littlefs unavailable");
    return false;
  }
  int failed = 0, copied = legacy ? copy_legacy(&failed) : 0;
  if (legacy) esp_vfs_littlefs_unregister_partition(&g_legacy_part);
  FILE *m = fopen(kMigratedMarker, "wb");
  if (m) {
    fprintf(m, "legacy=%d copied=%d failed=%d\n", legacy, copied, failed);
    fflush(m);
    fsync(fileno(m));
    fclose(m);
  }
  log_line("migrate: done legacy=%d copied=%d failed=%d", legacy, copied, failed);
  return true;
}

void identity() {
  uint8_t macb[6] = {0};
  esp_read_mac(macb, ESP_MAC_BT);
  snprintf(g_mac, sizeof g_mac, "%02X:%02X:%02X:%02X:%02X:%02X", macb[0], macb[1], macb[2],
           macb[3], macb[4], macb[5]);
  // Same default name as the app (FNV-1a of the MAC), or the user's from NVS.
  uint32_t h = 2166136261u;
  for (int i = 0; i < 6; i++) h = (h ^ macb[i]) * 16777619u;
  snprintf(g_name, sizeof g_name, "Led Widget %06lX", (unsigned long)(h & 0xFFFFFF));
  Preferences p;
  if (p.begin("ledmapper", true)) {
    String n = p.getString("name", "");
    if (n.length() > 0) {
      strncpy(g_name, n.c_str(), sizeof g_name - 1);
      g_name[sizeof g_name - 1] = 0;
    }
    p.end();
  }
}

}  // namespace

// -- the transport's lm_* seam (netstack_transport.h) ----------------------------------

int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply) {
  *reply = g_tx.data;
  return dispatch(in, len);
}

int lm_player_ble_reply(const uint8_t *in, size_t len, const uint8_t **reply) {
  *reply = g_tx.data;
  return dispatch(in, len);
}

int lm_agent_manifest_body(const char *cert_sha256, const uint8_t **body) {
  int n = snprintf(reinterpret_cast<char *>(g_tx.data), sizeof g_tx.data,
                   "{\"schema\":\"splanc-agent/1\",\"device\":{\"id\":\"%s\",\"name\":\"%s\","
                   "\"board\":\"\"},\"firmware\":{\"version\":\"loader-%s\",\"commit\":\"%s\","
                   "\"dirty\":%s,\"mode\":\"loader\"},\"protocol\":{\"package\":\"ledmapper.v1\","
                   "\"ws_path\":\"/ws\",\"profile\":\"loader\",\"features\":[\"ota\",\"loader\",\"tls_info\"],"
                   "\"fxb_format\":0},\"tls\":{\"cert_sha256\":\"%s\"},\"bundle\":null}",
                   g_mac, g_name, LM_VERSION, LM_GIT_COMMIT, LM_GIT_DIRTY ? "true" : "false",
                   cert_sha256);
  *body = g_tx.data;
  return n > 0 && (size_t)n < sizeof g_tx.data ? n : -1;
}

void lm_publish_tls_info(const char *state, const char *cert_sha256, bool persisted) {
  strncpy(g_tls_state, state, sizeof g_tls_state - 1);
  strncpy(g_cert_sha, cert_sha256, sizeof g_cert_sha - 1);
  g_tls_persisted = persisted;
}

int lm_mdns_reply(const uint8_t *query, size_t qlen, uint16_t src_port, const uint8_t *ip,
                  uint8_t *out, size_t cap, bool *unicast) {
  return query ? (int)loader_mdns_respond(query, qlen, src_port, ip, out, cap, unicast)
               : (int)loader_mdns_announce(ip, out, cap);
}

// #311: credentials a BLE provision in the loader leases on are kept, same keys as the app.
bool lm_store_wifi_credentials(const char *ssid, const char *pass) {
  Preferences p;
  if (!p.begin("ledmapper", false)) return false;
  size_t sn = p.putString("ssid", ssid);
  size_t pn = p.putString("pass", pass);
  p.end();
  return sn == strlen(ssid) && pn == strlen(pass);
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(50);
  g_loader_version = ota_parse_version(LM_VERSION);
  g_ota.begin(kOtaNs, false);
  g_app = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr);
  g_app_version = g_ota.getUInt("app_ver", 0);
  if (g_ota.getUInt("ldr_ver", 0) != g_loader_version) g_ota.putUInt("ldr_ver", g_loader_version);
  g_ota.getString("last", g_last, sizeof g_last);

  // Before anything else: the filesystem (and its one-time move from the legacy
  // layout), so no path can boot an app over un-migrated data.
  g_fs_ok = fs_prepare();

  uint8_t rec[OTA_RESUME_LEN];
  OtaLoaderInputsC in = {};
  in.app = app_state();
  in.update_incomplete = g_ota.getBytes("job", rec, sizeof rec) == sizeof rec;
  in.handoff = g_ota.getUChar("handoff", OTA_HANDOFF_NONE);
  in.reset = reset_class();
  in.retry_spent = g_ota.getUChar("retry", 0) != 0;
  g_ota.putUChar("handoff", OTA_HANDOFF_NONE);  // one-shot
  g_app_bootable = in.app == 1;

  bool kat = crypto_self_test();
  load_key_state();
  uint32_t flash_size = 0;
  esp_flash_get_size(nullptr, &flash_size);  // the chip's real size (the image header says 4MB)
  log_line("boot %s (%s) flash=%luK slot=0x%lx+0x%lx app=%u app_ver=%lu job=%d handoff=%u reset=%u "
           "ring=0x%lx (%s) epoch=%lu revoked=0x%lx floor=%u kat=%s",
           LM_VERSION, LM_GIT_COMMIT_SHORT, (unsigned long)(flash_size / 1024),
           (unsigned long)(g_app ? g_app->address : 0),
           (unsigned long)(g_app ? g_app->size : 0), in.app, (unsigned long)g_app_version,
           in.update_incomplete, in.handoff, in.reset, (unsigned long)ota_key::kRingMask,
           ota_key::kRing[0].name, (unsigned long)g_keys.epoch, (unsigned long)g_keys.revoked,
           g_keys.security_floor, kat ? "ok" : "FAILED");

  uint32_t idle = 0;
  const char *reason = "";
  uint8_t act = ota_loader_decide(&in, &reason, &idle);
  uint32_t pending = g_ota.getUInt("pending", 0);
  if ((in.app == 2 || in.app == 3) && pending != 0 && act != 1) {
    // The install we made didn't prove healthy: the bootloader (or the app) rolled it back.
    set_last("rolled_back");
    g_ota.putUInt("pending", 0);
  }
  if (act == 0) boot_app(false);
  if (act == 1) {
    log_line("app rolled back by a power cut during its verify window: retrying it once");
    g_ota.putUChar("retry", 1);
    boot_app(false);
  }
  g_reason = reason;
  if (idle > 0) g_idle_deadline = millis() + idle;
  log_line("recovery: reason=%s last=%s", g_reason, g_last);

  // Recovery: the network, then wait for an image.
  identity();
  char ver[40];
  snprintf(ver, sizeof ver, "loader-%s", LM_VERSION);
  loader_set_identity(g_mac, g_name, ver);
  Preferences p;
  String ssid, pass;
  if (p.begin("ledmapper", true)) {
    ssid = p.getString("ssid", "");
    pass = p.getString("pass", "");
    p.end();
  }
  // No BLE in the loader (improv_ble_none.cpp): Wi-Fi comes from the stored credentials or
  // a wired-console PROV line.
  device_cert_begin(g_mac, g_fs_ok ? &kTlsStore : nullptr);
  netstack_restore_credentials(ssid.c_str(), pass.c_str());
  netstack_setup();
  log_line("serving: fs=%d creds=%d", g_fs_ok, ssid.length() > 0);
}

void loop() {
  netstack_loop();
  uint32_t now = millis();
  if (g_restart_pending && (int32_t)(now - g_restart_at) >= 0) {
    if (g_app_bootable && g_ota.getUChar("handoff", OTA_HANDOFF_NONE) == OTA_HANDOFF_NONE) {
      boot_app(netstack_leased());
    }
    netstack_prepare_restart();
    esp_restart();
  }
  if (g_idle_deadline != 0 && !ota_session_active() && (int32_t)(now - g_idle_deadline) >= 0) {
    g_idle_deadline = 0;
    if (g_app_bootable && app_image_valid()) {
      log_line("no update arrived: returning to the app");
      boot_app(netstack_leased());
    }
  }
  static uint32_t last_report = 0;
  if (now - last_report > 5000) {
    last_report = now;
    log_line("status reason=%s session=%d offset=%lu/%lu leased=%d ws=%d heap=%u",
             g_reason, ota_session_active(), (unsigned long)ota_session_offset(),
             (unsigned long)ota_session_size(), netstack_leased(), netstack_ws_open(),
             (unsigned)ESP.getFreeHeap());
  }
}
