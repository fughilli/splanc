// C ABI over the Rust OTA core (firmware/ota/src/capi.rs; docs/design/ota.md).
// Returned strings are static and NUL-terminated; a null `const char *` return
// means success.
#ifndef FIRMWARE_OTA_OTA_FFI_H_
#define FIRMWARE_OTA_OTA_FFI_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OTA_MANIFEST_LEN 108
#define OTA_SIGNED_LEN 44
#define OTA_RESUME_LEN 112
#define OTA_MAX_CHUNK 4096
#define OTA_CHIP_ESP32C6 0x000D
#define OTA_CHIP_ESP32C3 0x0005

// ClientMessage arms (ledmapper.proto).
#define OTA_ARM_HELLO 1
#define OTA_ARM_TIME_SYNC_PING 2
#define OTA_ARM_GET_TLS_INFO 45
#define OTA_ARM_BEGIN 60
#define OTA_ARM_CHUNK 61
#define OTA_ARM_FINISH 62
#define OTA_ARM_ABORT 63
#define OTA_ARM_GET_STATUS 64
#define OTA_ARM_REBOOT 65

// OtaStatus.Mode / OtaStatus.State.
#define OTA_MODE_APP 1
#define OTA_MODE_LOADER 2
#define OTA_STATE_IDLE 0
#define OTA_STATE_REBOOTING 1
#define OTA_STATE_RECEIVING 2
#define OTA_STATE_VERIFYING 3
#define OTA_STATE_INSTALLED 4
#define OTA_STATE_FAILED 5

// Health / crash-loop constants (boot.rs).
#define OTA_HEALTH_DEADLINE_MS 120000u
#define OTA_WATCHDOG_MS 150000u
#define OTA_STABLE_UPTIME_MS 60000u

// Handoff reasons the app leaves for the loader (NVS "splanc_ota"/"handoff").
#define OTA_HANDOFF_NONE 0
#define OTA_HANDOFF_UPDATE 1
#define OTA_HANDOFF_STAY 2
#define OTA_HANDOFF_CRASH_LOOP 3

typedef struct {
  uint32_t version;
  uint32_t size;
  uint8_t sha256[32];
  uint32_t flags;
  uint8_t signed_bytes[OTA_SIGNED_LEN];
  uint8_t signature[64];  // r || s
} OtaManifestC;

bool ota_manifest_parse(const uint8_t *p, size_t len, OtaManifestC *out);
uint32_t ota_parse_version(const char *s);
const char *ota_check_offer(const uint8_t *p, size_t len, bool signature_ok, uint32_t slot_size,
                            uint32_t installed_version, bool allow_downgrade);

typedef struct {
  uint32_t arm;  // ClientMessage oneof field number (0 = none)
  uint32_t manifest_off;
  uint32_t manifest_len;
  bool allow_downgrade;
  uint32_t offset;
  uint32_t data_off;
  uint32_t data_len;
  uint8_t target;  // ota_reboot: 0 app, 1 loader
  double t0;       // time_sync_ping
  uint32_t epoch_off;  // ota_begin.key_epoch (len 0 = absent)
  uint32_t epoch_len;
} OtaClientMsg;

// 0 = parsed; -1 bad args; -2 malformed.
int32_t ota_parse_client(const uint8_t *frame, size_t len, OtaClientMsg *out);

typedef struct {
  uint8_t mode;
  uint8_t state;
  uint32_t version;
  uint32_t size;
  uint32_t offset;
  const char *error;
  uint32_t app_version;
  const char *app_fw_version;
  const char *loader_reason;
  const char *last_result;
  uint32_t loader_version;
  uint32_t max_chunk;
  uint32_t slot_size;
  uint32_t key_epoch;
  uint32_t revoked_keys;
  uint32_t security_floor;
} OtaStatusC;

// Encoders: the encoded length, or -2 when it doesn't fit.
int32_t ota_encode_status(const OtaStatusC *s, uint8_t *out, size_t cap);
int32_t ota_encode_error(const char *code, const char *msg, uint8_t *out, size_t cap);
int32_t ota_encode_time_sync_pong(double t0, double t1, double t2, uint8_t *out, size_t cap);
int32_t ota_encode_tls_info(const char *state, const char *cert_sha256, bool persisted,
                            uint8_t *out, size_t cap);
int32_t ota_encode_loader_welcome(const char *mac, const char *device_name,
                                  const char *fw_git_commit, bool fw_git_dirty,
                                  const char *fw_version, const OtaStatusC *s, uint8_t *out,
                                  size_t cap);

// The loader's receive session (one at a time).
const char *ota_session_begin(const uint8_t *manifest, size_t manifest_len, bool signature_ok,
                              uint32_t slot_size, uint16_t chip, uint32_t installed_version,
                              bool allow_downgrade, const uint8_t *resume, size_t resume_len);
bool ota_session_active(void);
uint32_t ota_session_offset(void);
uint32_t ota_session_size(void);
uint32_t ota_session_version(void);
bool ota_session_sha256(uint8_t out[32]);
void ota_session_reset(void);
bool ota_session_resume_record(uint8_t out[OTA_RESUME_LEN]);

typedef struct {
  uint32_t erase_off;
  uint32_t erase_len;  // 0 = nothing to erase
  uint32_t write_at;
  uint32_t len;
} OtaPlanC;

const char *ota_session_plan(uint32_t offset, const uint8_t *data, size_t len, uint16_t chip,
                             OtaPlanC *out);
// True when the progress must be persisted now.
bool ota_session_commit(const OtaPlanC *p);
const char *ota_session_finish_ready(void);
bool ota_resume_info(const uint8_t *p, size_t len, uint32_t *version, uint32_t *size,
                     uint32_t *offset);

typedef struct {
  uint8_t app;  // 0 missing, 1 bootable, 2 aborted, 3 invalid
  bool update_incomplete;
  uint8_t handoff;  // OTA_HANDOFF_*
  uint8_t reset;    // 0 power-on, 1 brownout, 2 software, 3 panic, 4 watchdog, 5 other
  bool retry_spent;
} OtaLoaderInputsC;

// 0 boot the app, 1 retry the aborted app once, 2 recovery (reason + idle timeout set).
uint8_t ota_loader_decide(const OtaLoaderInputsC *i, const char **reason,
                          uint32_t *idle_timeout_ms);

uint32_t ota_crash_count(uint32_t prev, bool magic_ok, uint8_t reset, bool *loop_tripped);

typedef struct {
  uint32_t uptime_ms;
  bool render_alive;
  bool tls_ready;
  bool network_required;
  bool leased;
} OtaHealthC;

// 0 wait, 1 healthy, 2 failed (`why` set).
uint8_t ota_health(const OtaHealthC *h, const char **why);

// Keyring, key epochs, security floor (keyring.rs; docs/design/ota.md "Key rotation").
#define OTA_EPOCH_LEN 80
#define OTA_KEY_RELEASE 0
#define OTA_KEY_BACKUP 1
#define OTA_KEY_NEXT 2

typedef struct {
  uint32_t epoch;
  uint32_t revoked;  // bit n = key id n revoked
  uint8_t security_floor;
} OtaKeyStateC;

// Null when the manifest may be verified with ring key *out_id.
const char *ota_key_select(const uint8_t *manifest, size_t len, uint32_t ring_mask,
                           const OtaKeyStateC *st, uint8_t *out_id);
uint8_t ota_floor_after(const OtaKeyStateC *st, const uint8_t *manifest, size_t len);

typedef struct {
  uint32_t epoch;
  uint32_t revoked;
  uint8_t signer;
  uint8_t signed_bytes[16];
  uint8_t signature[64];
} OtaEpochC;

bool ota_epoch_parse(const uint8_t *p, size_t len, OtaEpochC *out);
const char *ota_epoch_apply(const OtaKeyStateC *st, const uint8_t *p, size_t len, bool signature_ok,
                            uint32_t ring_mask, OtaKeyStateC *out);

#ifdef __cplusplus
}
#endif

#endif  // FIRMWARE_OTA_OTA_FFI_H_
