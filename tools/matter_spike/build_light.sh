#!/usr/bin/env bash
# Build esp-matter's `light` example for the ESP32-C6 with sdkconfig overlays.
# usage: build_light.sh <build_dir> [overlay.defaults ...]
# Needs ESP-IDF v5.5.5 + esp-matter release/v1.5 exported (`. $IDF_PATH/export.sh`,
# `. $ESP_MATTER_PATH/export.sh`) and the patch applied:
#   git -C "$ESP_MATTER_PATH" apply tools/matter_spike/esp_matter_light.patch
# For the PoC add an overlay with CONFIG_ENABLE_WIFI_STATION=y,
# CONFIG_DEFAULT_WIFI_SSID / _PASSWORD (never commit it).
set -euo pipefail
B=$(realpath -m "$1"); shift
D="sdkconfig.defaults"
for f in "$@"; do D="$D;$(realpath "$f")"; done
cd "$ESP_MATTER_PATH/examples/light"
idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" -D SDKCONFIG_DEFAULTS="$D" set-target esp32c6
idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" build
idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" size
idf.py -B "$B" -D SDKCONFIG="$B/sdkconfig" size-components
