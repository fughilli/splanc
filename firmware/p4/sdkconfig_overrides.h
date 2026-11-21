// sdkconfig overrides for the ESP32-P4 player (@embedded//sdk, wired in .bazelrc).
// The SDK's archives keep their frozen sdkconfig; these apply to everything compiled
// from source, and embedded rebuilds the IDF components an option changes.

// Static buffers in PSRAM (EXT_RAM_BSS_ATTR): esp_psram rebuilt from source keeps the
// section out of the PSRAM heap and zeroes it at boot; its sections.ld places it.
// Internal RAM is what the USB host's endpoints and DMA come from (a 32 KB internal
// stack left it short: the tracker's IMU interface failed to claim, 2026-11-18).
#define CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY 1
