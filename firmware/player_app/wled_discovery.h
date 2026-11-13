// WLED board discovery on the Ethernet network (docs/design/p4-ethernet-ddp.md):
// an mDNS PTR query for _wled._tcp, then GET /json/info on each board for its
// name, LED count, MAC and version.
//
// Scans run on a task of their own. wled_discover() starts one and waits up to
// `timeout_ms` for it, then returns everything found so far, this scan or an
// earlier one, so a slow board shows up on the next request.
#ifndef FIRMWARE_PLAYER_APP_WLED_DISCOVERY_H_
#define FIRMWARE_PLAYER_APP_WLED_DISCOVERY_H_

#include <stddef.h>
#include <stdint.h>

#include "firmware/netout/netout_ffi.h"

#define WLED_DISCOVERY_MAX 16

// Start a scan, wait up to `timeout_ms`, and copy the known boards into
// `out[0..cap)`. Returns how many. `*err` is NULL, or "no_link" when Ethernet
// isn't up (nothing is scanned; the cache is still returned).
size_t wled_discover(uint32_t timeout_ms, NetoutController *out, size_t cap, const char **err);

// Forget every board found (Ethernet was reconfigured).
void wled_discovery_forget(void);

#endif  // FIRMWARE_PLAYER_APP_WLED_DISCOVERY_H_
