// See ota_app.h and docs/design/ota.md. The decisions (health verdict, crash-loop
// count, offer checks, wire encoding) are the host-tested Rust core (firmware/ota,
// reached through ota_ffi.h); this file is the ESP-IDF glue around them.
#include "firmware/player_app/ota_app.h"

#include <Arduino.h>
#include <Preferences.h>
#include <esp_attr.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <hal/rwdt_ll.h>
#include <mbedtls/sha256.h>
#include <soc/rtc.h>
#include <string.h>

#include "firmware/player_app/build_info.h"
#include "firmware/ota/ota_ffi.h"
#include "firmware/player_app/serial_log.h"

// netstack_transport.h (weak: the vendor-stack bench images have no netstack): leave the
// AP and keep the MAC across a planned restart, so the IP survives the handoff.
void netstack_prepare_restart(void) __attribute__((weak));

static void planned_restart_prep() {
  if (netstack_prepare_restart) netstack_prepare_restart();
}

// Arduino's initArduino() marks a pending app valid at boot unless this says the app
// will decide later. It will: ota_app_poll, once healthy.
extern "C" bool verifyRollbackLater() { return true; }

namespace {

constexpr const char *kOtaNs = "splanc_ota";
constexpr uint32_t kCrashMagic = 0x4f54414c;  // "OTAL"

RTC_NOINIT_ATTR uint32_t s_crash_magic;
RTC_NOINIT_ATTR uint32_t s_crash_count;

bool g_pending = false;          // this boot is a fresh install, pending verify
bool g_network_required = false; // the loader was online when it booted us
bool g_stable = false;           // crash counter cleared for this boot
const esp_partition_t *g_loader = nullptr;
const esp_partition_t *g_slot = nullptr;
uint32_t g_handoff_at = 0;       // restart into the loader then (0 = none)
uint32_t g_app_version = 0;      // manifest version of this image (0 unknown)
bool g_version_checked = false;
char g_last[24] = "";
uint32_t g_loader_version = 0;
uint32_t g_key_epoch = 0, g_revoked = 0, g_floor = 0;  // the loader's key state (NVS)

uint8_t reset_class() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
    case ESP_RST_EXT:
    case ESP_RST_USB:
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

// The RTC (LP) watchdog: independent of the CPU and every task, so a pending app that
// hangs anywhere still resets — and a reset while pending verify rolls back. The
// inline LL calls, as the swarm loader found the wdt_hal_* path never armed it.
void arm_health_deadline(uint32_t ms) {
  lp_wdt_dev_t *hw = &LP_WDT;
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
  lp_wdt_dev_t *hw = &LP_WDT;
  rwdt_ll_write_protect_disable(hw);
  rwdt_ll_disable(hw);
  rwdt_ll_write_protect_enable(hw);
}

bool ota_layout() { return g_loader != nullptr && g_slot != nullptr; }

// Leave a note for the loader and make the next boot the loader (selecting the
// factory app erases otadata).
void schedule_handoff(uint8_t handoff) {
  Preferences p;
  if (p.begin(kOtaNs, false)) {
    p.putUChar("handoff", handoff);
    p.end();
  }
  g_handoff_at = millis() + 400;  // after the reply is on the wire
  if (g_handoff_at == 0) g_handoff_at = 1;
}

// This image's manifest version: what the loader recorded at install, if the slot
// still holds that image (a USB flash since then makes it unknown). Checked once,
// lazily: hashing the slot takes a few hundred ms.
uint32_t app_version() {
  if (g_version_checked) return g_app_version;
  g_version_checked = true;
  Preferences p;
  uint8_t want[32];
  uint32_t v = 0, size = 0;
  if (p.begin(kOtaNs, true)) {
    v = p.getUInt("app_ver", 0);
    size = p.getUInt("app_size", 0);
    if (p.getBytes("app_sha", want, sizeof want) != sizeof want) v = 0;
    p.end();
  }
  if (v == 0 || g_slot == nullptr || size == 0 || size > g_slot->size) return g_app_version = 0;
  static uint8_t buf[2048];
  mbedtls_sha256_context h;
  mbedtls_sha256_init(&h);
  bool ok = mbedtls_sha256_starts(&h, 0) == 0;
  for (uint32_t off = 0; ok && off < size; off += sizeof buf) {
    uint32_t n = size - off < sizeof buf ? size - off : sizeof buf;
    ok = esp_partition_read(g_slot, off, buf, n) == ESP_OK && mbedtls_sha256_update(&h, buf, n) == 0;
  }
  uint8_t got[32];
  ok = ok && mbedtls_sha256_finish(&h, got) == 0;
  mbedtls_sha256_free(&h);
  g_app_version = ok && memcmp(got, want, 32) == 0 ? v : 0;
  Log().printf("[ota] slot holds manifest v%lu? %s (%lu B re-hashed)\n", (unsigned long)v,
               g_app_version ? "yes" : "no: USB-flashed or changed", (unsigned long)size);
  return g_app_version;
}

int status_reply(uint8_t state, const char *error, uint8_t *out, size_t cap) {
  OtaStatusC s;
  memset(&s, 0, sizeof s);
  s.mode = OTA_MODE_APP;
  s.state = state;
  s.error = error;
  s.app_version = ota_layout() ? app_version() : 0;
  s.app_fw_version = LM_VERSION;
  s.loader_reason = "";
  s.last_result = g_last;
  s.loader_version = g_loader_version;
  s.max_chunk = OTA_MAX_CHUNK;
  s.slot_size = g_slot ? g_slot->size : 0;
  s.key_epoch = g_key_epoch;
  s.revoked_keys = g_revoked;
  s.security_floor = g_floor;
  return (int)ota_encode_status(&s, out, cap);
}

}  // namespace

void ota_app_boot() {
  g_loader = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, nullptr);
  const esp_partition_t *running = esp_ota_get_running_partition();
  g_slot = running && running->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ? running : nullptr;

  Preferences p;
  if (p.begin(kOtaNs, true)) {
    p.getString("last", g_last, sizeof g_last);
    g_loader_version = p.getUInt("ldr_ver", 0);
    g_network_required = p.getUChar("net", 0) != 0;
    g_key_epoch = p.getUInt("kepoch", 0);
    g_revoked = p.getUInt("krevoked", 0);
    g_floor = p.getUChar("sfloor", 0);
    p.end();
  }

  esp_ota_img_states_t st;
  g_pending = running && esp_ota_get_state_partition(running, &st) == ESP_OK &&
              st == ESP_OTA_IMG_PENDING_VERIFY;
  if (g_pending) arm_health_deadline(OTA_WATCHDOG_MS);

  bool magic_ok = s_crash_magic == kCrashMagic;
  bool tripped = false;
  s_crash_count = ota_crash_count(magic_ok ? s_crash_count : 0, magic_ok, reset_class(), &tripped);
  s_crash_magic = kCrashMagic;
  Log().printf("[ota] layout=%s slot=%s pending=%d net_required=%d crash_count=%lu last=%s\n",
               ota_layout() ? "loader+app" : "legacy", g_slot ? g_slot->label : "-", g_pending,
               g_network_required, (unsigned long)s_crash_count, g_last);
  if (tripped && ota_layout() && !g_pending) {
    // Valid, but it keeps dying soon after boot: rollback no longer covers it, so hand
    // the fixture to the loader (recovery, reason crash_loop) instead of looping.
    Log().printf("[ota] crash loop (%lu crash resets in a row): handing over to the loader\n",
                 (unsigned long)s_crash_count);
    s_crash_count = 0;
    Preferences w;
    if (w.begin(kOtaNs, false)) {
      w.putUChar("handoff", OTA_HANDOFF_CRASH_LOOP);
      w.end();
    }
    delay(100);
    esp_ota_set_boot_partition(g_loader);
    esp_restart();
  }
}

void ota_app_poll(bool render_alive, bool tls_ready, bool leased) {
  uint32_t now = millis();
  if (g_handoff_at != 0 && (int32_t)(now - g_handoff_at) >= 0) {
    g_handoff_at = 0;
    Log().printf("[ota] restarting into the loader\n");
    delay(50);
    planned_restart_prep();
    if (g_loader) esp_ota_set_boot_partition(g_loader);
    esp_restart();
  }
  if (!g_stable && now >= OTA_STABLE_UPTIME_MS) {
    g_stable = true;
    s_crash_count = 0;
  }
  if (!g_pending) return;
  OtaHealthC h = {now, render_alive, tls_ready, g_network_required, leased};
  const char *why = nullptr;
  uint8_t v = ota_health(&h, &why);
  if (v == 1) {
    g_pending = false;
    esp_ota_mark_app_valid_cancel_rollback();
    disarm_health_deadline();
    Preferences p;
    if (p.begin(kOtaNs, false)) {
      p.putUInt("pending", 0);
      p.putUChar("retry", 0);
      p.putUChar("net", 0);
      p.putString("last", "ok");
      p.end();
    }
    strcpy(g_last, "ok");
    Log().printf("[ota] healthy after %lu ms: marked valid\n", (unsigned long)now);
  } else if (v == 2) {
    Log().printf("[ota] not healthy by the deadline (%s): rolling back to the loader\n",
                 why ? why : "?");
    delay(100);
    planned_restart_prep();
    esp_ota_mark_app_invalid_rollback_and_reboot();  // -> factory (the loader)
  }
}

int ota_app_dispatch(const uint8_t *msg, size_t len, uint8_t *out, size_t cap) {
  OtaClientMsg m;
  if (ota_parse_client(msg, len, &m) != 0) return 0;  // let the player answer it
  switch (m.arm) {
    case OTA_ARM_GET_STATUS:
      return status_reply(OTA_STATE_IDLE, ota_layout() ? nullptr : "legacy_layout", out, cap);
    case OTA_ARM_BEGIN: {
      if (!ota_layout()) return status_reply(OTA_STATE_FAILED, "legacy_layout", out, cap);
      // Shape, size and version order only: the LOADER is the authority on the signature
      // (it holds the trusted key), so a bad signature costs one round trip through it.
      const char *err = ota_check_offer(msg + m.manifest_off, m.manifest_len, true, g_slot->size,
                                        app_version(), m.allow_downgrade);
      if (err != nullptr) return status_reply(OTA_STATE_FAILED, err, out, cap);
      Log().printf("[ota] update offered: handing over to the loader\n");
      schedule_handoff(OTA_HANDOFF_UPDATE);
      return status_reply(OTA_STATE_REBOOTING, nullptr, out, cap);
    }
    case OTA_ARM_CHUNK:
    case OTA_ARM_FINISH:
    case OTA_ARM_ABORT:
      return status_reply(OTA_STATE_FAILED, "not_in_loader", out, cap);
    case OTA_ARM_REBOOT:
      if (m.target == 1) {
        if (!ota_layout()) return status_reply(OTA_STATE_FAILED, "legacy_layout", out, cap);
        schedule_handoff(OTA_HANDOFF_STAY);
        return status_reply(OTA_STATE_REBOOTING, nullptr, out, cap);
      }
      g_handoff_at = 0;
      return status_reply(OTA_STATE_IDLE, nullptr, out, cap);
    default:
      return 0;
  }
}
