// C ABI of //firmware/netout (src/capi.rs): Ethernet config + network LED
// outputs for the P4 player (docs/design/p4-ethernet-ddp.md).
//
// The settings live in the Rust static. Call everything except the DDP packet
// helpers from the one task that runs lm_player_handle.
#ifndef FIRMWARE_NETOUT_NETOUT_FFI_H_
#define FIRMWARE_NETOUT_NETOUT_FFI_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// IPv4 addresses are uint32_t holding the four octets big-endian
// (192.168.50.1 == 0xC0A83201), as on the wire. lwIP's ip4_addr_t.addr holds
// them in network byte order, so convert with htonl / ntohl.

typedef struct {
  uint8_t enabled;
  uint8_t phy;  // 1 ip101, 2 lan8720, 3 rtl8201, 4 dp83848, 5 ksz80xx
  int8_t phy_addr;  // -1 = scan
  int8_t mdc;
  int8_t mdio;
  int8_t reset;  // -1 = none
  uint8_t clock;  // 0 = 50 MHz in on GPIO50, 1 = out on clock_gpio
  int8_t clock_gpio;
  uint8_t ip_mode;  // 0 DHCP client, 1 static, 2 DHCP server
  uint32_t ip;
  uint32_t netmask;
  uint32_t gateway;
} NetoutEthConfig;

typedef struct {
  uint32_t ip;
  uint16_t port;  // default filled in (4048 for DDP)
} NetoutTarget;

typedef struct {
  uint8_t link_up;
  uint8_t full_duplex;
  uint32_t speed_mbps;
  uint32_t ip;
  uint32_t netmask;
  uint32_t gateway;
  uint8_t mac[6];
  uint32_t tx_frames;
  uint32_t tx_errors;
} NetoutLinkStatus;

typedef struct {
  char name[33];
  char version[17];
  uint32_t ip;
  uint8_t mac[6];
  uint32_t led_count;
} NetoutController;

// Ethernet ClientMessage arms (95-98); 0 = not an Ethernet request.
#define NETOUT_ARM_SET_ETHERNET_CONFIG 95
#define NETOUT_ARM_GET_ETHERNET_STATE 96
#define NETOUT_ARM_DISCOVER_CONTROLLERS 97
#define NETOUT_ARM_SET_NETWORK_OUTPUT 98
int32_t netout_arm(const uint8_t *msg, size_t len);

// Apply a set request. `busy` = GPIOs the LED strips drive. Returns NULL on
// success (netout_gen() bumps) or a static error code (nothing changed).
const char *netout_apply(const uint8_t *msg, size_t len, const int32_t *busy, size_t n_busy);
uint32_t netout_discover_timeout_ms(const uint8_t *msg, size_t len);

uint32_t netout_gen(void);
int32_t netout_commit(void);
void netout_config(NetoutEthConfig *out);
// 1 and *out filled when LED `channel` is a network channel with a target.
int32_t netout_output(int32_t channel, NetoutTarget *out);
// GPIOs the enabled Ethernet config takes (0 when disabled).
size_t netout_busy_pins(int32_t *out, size_t cap);
int32_t netout_first_channel(void);
int32_t netout_channels(void);

// Replies. Return the encoded ServerMessage length, 0 if `cap` is short.
size_t netout_encode_state(const NetoutLinkStatus *st, const char *error, uint8_t *out, size_t cap);
size_t netout_encode_controllers(const NetoutController *list, size_t n, const char *error,
                                 uint8_t *out, size_t cap);

// Flash blob.
size_t netout_blob_len(void);
size_t netout_save(uint8_t *out, size_t cap);
int32_t netout_load(const uint8_t *blob, size_t len);  // 1 loaded, 0 kept defaults

// Parse a WLED GET /json/info body into *out (ip untouched). 1 = a WLED reply.
// Pure: safe from any task.
int32_t netout_parse_wled_info(const uint8_t *json, size_t len, NetoutController *out);

// DDP. Pure: safe from any task.
#define NETOUT_DDP_MAX_PACKET 1450
size_t netout_ddp_packet_count(size_t len);
size_t netout_ddp_packet(const uint8_t *data, size_t len, size_t index, uint8_t seq, uint8_t *out,
                         size_t cap);
uint8_t netout_ddp_next_seq(uint8_t seq);

#ifdef __cplusplus
}
#endif

#endif  // FIRMWARE_NETOUT_NETOUT_FFI_H_
