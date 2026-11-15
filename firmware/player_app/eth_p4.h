// Ethernet on the ESP32-P4 (docs/design/p4-ethernet-ddp.md): the P4's EMAC over
// RMII to an external PHY, with an lwIP netif as a DHCP client, a static
// address or the DHCP server of a private LED network. The config comes from
// //firmware/netout (validated there); this file only drives the IDF.
//
// Call everything from one task (the player's loop task). Status reads are
// safe from any task.
#ifndef FIRMWARE_PLAYER_APP_ETH_P4_H_
#define FIRMWARE_PLAYER_APP_ETH_P4_H_

#include <stdint.h>
#include <string.h>

#include "firmware/netout/netout_ffi.h"

// Wire IPv4 (octets big-endian in a u32, as netout uses) <-> network byte
// order (lwIP's in_addr / ip4_addr_t). Byte-wise rather than htonl / ntohl: on
// the P4 (RV32 without Zbb) GCC lowers those to a __bswapsi2 libcall, which the
// link then resolves from the Rust staticlib's soft-float compiler-builtins and
// refuses to mix with the single-float objects.
static inline uint32_t eth_to_nbo32(uint32_t be) {
  const uint8_t b[4] = {(uint8_t)(be >> 24), (uint8_t)(be >> 16), (uint8_t)(be >> 8), (uint8_t)be};
  uint32_t v;
  memcpy(&v, b, 4);
  return v;
}
static inline uint32_t eth_from_nbo32(uint32_t n) {
  uint8_t b[4];
  memcpy(b, &n, 4);
  return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
}
static inline uint16_t eth_to_nbo16(uint16_t v) {
  const uint8_t b[2] = {(uint8_t)(v >> 8), (uint8_t)v};
  uint16_t r;
  memcpy(&r, b, 2);
  return r;
}

// Bring Ethernet to `cfg`: stop it when cfg.enabled == 0, otherwise (re)start
// the driver with the new PHY, pins and addressing. Returns NULL on success or
// a machine code ("phy_not_found", "emac_init", "netif", "bad_phy").
const char *eth_p4_apply(const NetoutEthConfig &cfg);

// The running state: link, speed, duplex, the address in use, the MAC.
// tx_frames / tx_errors are left 0 (net_output fills them).
void eth_p4_status(NetoutLinkStatus *st);

// The last bring-up error (an empty string when fine or disabled).
const char *eth_p4_error(void);

// True when the link is up and the netif has an IPv4 address: DDP can go out.
bool eth_p4_ready(void);

// The Ethernet netif's IPv4 address (network byte order), 0 when none.
uint32_t eth_p4_ip_nbo(void);

#endif  // FIRMWARE_PLAYER_APP_ETH_P4_H_
