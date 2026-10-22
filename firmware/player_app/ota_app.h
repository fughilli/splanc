// The app's half of over-the-air updates (docs/design/ota.md): it never writes an
// image itself. It answers the OTA arms (status; ota_begin checks the manifest and
// hands over to the loader, which takes the image), proves a fresh install healthy
// before marking it valid, and hands itself to the loader when it crash-loops.
#ifndef FIRMWARE_PLAYER_APP_OTA_APP_H_
#define FIRMWARE_PLAYER_APP_OTA_APP_H_

#include <stddef.h>
#include <stdint.h>

// First thing in setup() (after the log starts): the crash-loop guard and, for a
// fresh install still pending verify, the RTC-watchdog health deadline.
void ota_app_boot();

// From loop(): evaluate health while pending verify (mark valid / roll back), clear
// the crash counter once the boot is stable, and run a scheduled handoff restart.
// `render_alive`: the render task advanced in the last couple of seconds.
void ota_app_poll(bool render_alive, bool tls_ready, bool leased);

// An OTA arm? Then the reply (ServerMessage) is in `out` and its length returned
// (>0); 0 = not an OTA arm (dispatch it normally); <0 = malformed.
int ota_app_dispatch(const uint8_t *msg, size_t len, uint8_t *out, size_t cap);

// Fault-injection builds for the HITL OTA gate (LM_OTA_FAULT, main.cpp): 1 = crash at
// boot, 2 = never become healthy (no render task). 0 in every shipped image.
#ifndef LM_OTA_FAULT
#define LM_OTA_FAULT 0
#endif

#endif  // FIRMWARE_PLAYER_APP_OTA_APP_H_
