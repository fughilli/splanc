# Flash auto-suspend: flash writes never stall the render task

Desk D-459 (follow-up to D-323, "NO BLIPPING"); requirement PR-41 (with PR-40) / user need UN-9.

## Problem

The prebuilt ESP-IDF libraries (arduino-esp32 3.3.10, IDF v5.5.4) are built without
`CONFIG_SPI_FLASH_AUTO_SUSPEND`. Every flash erase or program then runs with the cache
disabled: no code runs from flash, so every task stops, the render task too, until the
operation ends. A 4 KiB sector erase on the C6's flash takes tens of milliseconds, and a
littlefs write (temp file, fsync, rename; sometimes a metadata compaction) can need
several. On hitl-rig-1 (#594, r4-r8) a fixture's first membership write (116-129 ms)
dropped one frame every time (a 21-37 ms render interval against 12.5 ms). The effect
store, map uploads, keypoints, color correction and NVS settings all write the same way.

## What changed

The flash controller of the ESP32-C6 can suspend an erase or program by itself when the
cache needs the flash, and resume it afterwards ("auto-suspend"). IDF switches it on with
`CONFIG_SPI_FLASH_AUTO_SUSPEND`, and then takes a mutex for SPI1 operations instead of
disabling the cache. In IDF v5.5.4 that switch touches two places:

- `spi_flash_os_func_app.c`: the SPI1 lock (cache-disabling, or a mutex with the cache on);
- `esp_flash_spi_init.c`: the host's suspend flags and `esp_flash_suspend_cmd_init()`.

Rebuilding the whole SDK for one option would mean taking over the arduino-esp32 lib-builder.
Instead, `firmware/player_app/flash_suspend/spi_flash_os_func_app.c` is IDF's file with the
lock mode chosen at run time, linked ahead of the prebuilt `libspi_flash.a` member (the
player links with `--allow-multiple-definition`, so the first definition wins), plus
`lm_flash_auto_suspend_enable()`. `setup()` calls that first thing. It:

1. checks the chip (ESP32-C6 >= v0.2, as `esp_flash_suspend_cmd_init()` does) and the flash:
   JEDEC manufacturer 0x46 (XMC), the in-package flash of the ESP32-C6FH4 on the rigs and the
   lamps, for which IDF's generic driver reports `SPI_FLASH_CHIP_CAP_SUSPEND`;
2. inside a stock (cache-disabled) operation, sets the host's auto-suspend and auto-resume
   flags (tSUS 50 µs, IDF's default) and runs the chip driver's `sus_setup`;
3. switches the SPI1 lock to the mutex. Every later operation's `device_config` programs
   the controller for auto-suspend.

Any other flash or chip keeps the stock behaviour (the boot line says why):
`[flash] auto-suspend on jedec=464016` or `off (flash not supported) jedec=...`.

Each littlefs write is timed in the log (`[fs] wrote <path> <bytes> B us=<µs>`), and the
render task reports late frames (`[late]`, #594).

## Handlers that write under the player mutex

The render task holds the player mutex for each frame, and a message handler holds it while
`lm_player_handle` runs. The keypoint and effect-store hooks write their files from inside
it, so the render task waited out the whole littlefs write: flash auto-suspend keeps code
running during an erase, but not a task blocked on a lock. Now those writes and removals
are queued (data copied to the heap, in order, reads of a queued path served from the queue)
and done right after the mutex is released, before the reply goes out. The store's space
check reads littlefs usage measured after the last write (below render), not a filesystem
walk under the mutex.

## Still late (follow-up)

On hitl-rig-1 the effect-store and keypoint handlers still hold the mutex for 30-70 ms
(`handle_max` in the `[net]` line): the keypoint save looks for its slot and lists them by
opening every `kp_<effect>.<n>` file (`kp_find`, `kp_list_reply`), and the store does
similar record bookkeeping. These are littlefs reads, not flash stalls. The fix is an
in-RAM index of those files, kept up to date by the hooks. Until then `flash_render`
reports those phases and gates them only with `--strict`.

## Verification

- `//pi/hitl/harness:flash_render_netstack` (tagged `hitl`): stores and deletes effects,
  uploads a 512-LED map and back, commits uniforms, saves keypoints, changes color
  correction and renames the device while an effect renders. It fails on any late frame
  in the map and settings phases (the effect-store and keypoint ones with `--strict`), and
  SKIPs on a flash without suspend support. `--allow-no-suspend` runs
  it against an image without auto-suspend (the A/B baseline).
- `mesh_join_admin` is strict again: late frames next to a membership write fail
  (`--allow-flash-late` relaxes it).

## Limits

- A cache miss during an erase waits for the suspend (tSUS, ~50 µs) and the read; the
  erase takes longer by that much per miss. Neither is close to a frame.
- Code must not read a flash region while it is being erased or programmed (its contents are
  undefined until the operation ends). Nothing in the player reads littlefs blocks through
  the cache except the color-correction LUT's mmap, which points at the live record (never
  erased while in use).
- The OTA loader keeps the stock lock (it renders nothing).
