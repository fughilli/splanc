# P4 Ethernet output: streaming DDP to WLED controllers

Status (2026-11-11, branch `agent/p4-ethernet-ddp`): stages 1–3 are written. The protocol,
`//firmware/netout`, the core's network channels, the P4 bring-up / DDP sender / discovery and the
Hardware Setup sections are in place. Host tests pass, and both P4 images and the C6 images build.
**Nothing has run on hardware yet**: the bench P4 (Waveshare ESP32-P4-WIFI6) has no PHY. Stage 4
is next.

Owner direction: _"We're going to next do a variant that runs on the P4 but streams DDP to the
same WLED controllers. We're going to need to add some features to the hardware setup page for
that build to allow configuring the ethernet settings/discovering WLED boards etc."_ And: _"These
should be new features to add to the existing P4 build so we can keep the number of firmware
configurations to a minimum."_ The path chosen was the P4's own Ethernet MAC with an RMII PHY,
not Wi-Fi through the C6.

Prior art: `docs/host-player.md` and `pi/player_rs/src/output.rs` (PR #476). The Mac host
player drives a WLED 16.0.1 board with 1680 LEDs over wired DDP, and that works end to end. This
doc brings the same output stage to the P4 player.

## 1. What it is

```text
 phone app ──wss──▶ C6 (Wi-Fi front end) ──SDIO──▶ P4 player ──RMII──▶ PHY ──UDP/DDP──▶ WLED boards
                                                    │
                                                    └─PARLIO──▶ WS2812 strips (unchanged)
```

- **One P4 firmware.** Ethernet, DDP output and discovery are runtime features of the existing
  `:esp32p4_player` / `:esp32p4_player_c6` images. Nothing is a build flag. With Ethernet
  disabled (the default) the player behaves exactly as today.
- **The PHY is configuration, not a build.** The PHY model, its MDIO address, MDC/MDIO/reset pins
  and the RMII reference-clock mode are hardware settings. The same image runs a Waveshare P4
  board with no PHY (Ethernet off), a P4-NANO / P4-Module-DEV-KIT (on-board IP101) or a bare P4
  board with an add-on LAN8720 module.
- **Network outputs are LED channels.** The core already has `MAX_CHANNELS = 8` logical LED
  channels, of which only `HW_CHANNELS = 2` drive GPIOs. Channels 2–7 become network outputs:
  each carries a target (protocol, IPv4 address, port) and an LED count. All channels form the
  one global LED index space mapping and effects already address (channel 0's LEDs first, then
  channel 1's, …), so mapping, effects, decks and the preview need no changes. A fixture can be
  local strips only, WLED boards only, or a mix of the two.
- **The controllers are dumb pixel sinks**, as on the Mac. The P4 renders. The WLED board only
  receives RGB.

## 2. Protocol (`shared/protocol/proto/ledmapper.proto`)

Every change is additive. Older firmware doesn't answer the new arms, and the app hides the
Ethernet section when `BoardCapabilities.ethernet` is absent.

| Message | Change |
| --- | --- |
| `EthernetConfig` (new) | `enabled`, `phy` (`"ip101"`, `"lan8720"`, `"rtl8201"`, `"dp83848"`, `"ksz80xx"`), `phy_addr` (−1 = auto-detect), `mdc_gpio`, `mdio_gpio`, `phy_reset_gpio` (−1 = none), `clock` (`RMII_CLOCK_EXT_IN` on GPIO50 or `RMII_CLOCK_OUT` on `clock_gpio`), `ip_mode` (`IP_MODE_DHCP_CLIENT`, `IP_MODE_STATIC`, `IP_MODE_DHCP_SERVER`), `ip` / `netmask` / `gateway` (IPv4 as `fixed32`, network byte order; used by static and DHCP-server modes). |
| `NetworkOutput` (new) | `channel` (2–7), `protocol` (`NET_PROTOCOL_DDP`; Art-Net reserved), `ip` (`fixed32`), `port` (0 = the protocol default, 4048 for DDP), `name` (display only, e.g. the WLED name discovery found). |
| `SetEthernetConfig` (new arm 95) | `config`, `commit` (unset = true, as in `SetHardwareConfig`). Reply: `EthernetState`. |
| `GetEthernetState` (new arm 96) | Reply: `EthernetState`. |
| `SetNetworkOutput` (new arm 98) | `output` (an `ip` of 0 clears the channel's target), `commit`. Reply: `EthernetState`. The channel's LED count is set the usual way with `set_led_count` (channels 2–7), so the core's one global LED index space, capacity checks and reboot-to-resize cover network channels too. |
| `EthernetState` (new arm 53) | `config` (echo), `outputs`, `link_up`, `speed_mbps`, `full_duplex`, `ip` / `netmask` / `gateway` (as running), `mac`, `error` (empty, or why bring-up failed, e.g. `"phy_not_found"`), `tx_frames` / `tx_errors` (DDP counters). |
| `DiscoverControllers` (new arm 97) | `timeout_ms` (default 600, capped at 800: the C6 waits 1000 ms for a forwarded reply, `main.cpp` `frontend_forward`). The P4 keeps the results between scans, so a second scan returns everything seen so far. Reply: `ControllerList`. |
| `ControllerList` (new arm 54) | `repeated DiscoveredController`: `name`, `ip`, `mac`, `led_count`, `version`, `kind` (`"wled"`). |
| `BoardCapabilities` | `+ EthernetCaps ethernet = 7`: the supported PHY ids, the board's default `EthernetConfig` (the pins for its on-board PHY, if any) and the GPIOs RMII takes (shown as busy in the LED pin picker while Ethernet is on). `+ uint32 net_channels = 8` (the number of network output channels, 6 on the P4). |

**Who answers.** As with the OTA arms (`firmware/ota/src/wire.rs`), arms 95–98 are hand-coded in
a small `no_std` crate, `firmware/netout`, and answered by the P4's C++ before the player core
sees the frame. A `wire_test` pins every hand-coded field number against the generated host
bindings. The core's by-value `ServerMessage` doesn't grow: the firmware micropb profile skips
the new messages' variable-size fields, as it already does for OTA and the FX debugger. The C6
front end forwards these arms untouched, because it forwards every arm it doesn't own
(`p4-c6-split.md` §2.2).

## 3. Firmware (P4)

| Piece | Where | What |
| --- | --- | --- |
| Wire, validation, persistence | `firmware/netout` (Rust, `no_std`, C ABI `netout_ffi.h`) | Parse and encode arms 95–98 and replies 53–54. Validate the config: a known PHY, pins in range and not used by the LED channels, a sane netmask. Serialise the config and outputs to a versioned NVS blob. Encode DDP packets (byte for byte the format of `pi/player_rs/src/output.rs`: a 10-byte header, 480 RGB pixels per packet, PUSH on the last, sequence 1–15). Host-tested. |
| Ethernet bring-up | `firmware/player_app/eth_p4.{h,cpp}` | IDF `esp_eth` (`esp_eth_mac_new_esp32` + `esp_eth_phy_new_*`), runtime pins via `eth_esp32_emac_config_t`, `esp_netif` with a DHCP client, a static address or a DHCP server. Started after boot from the persisted config. A config change takes Ethernet down and back up, with no reboot. The pinned SDK already has `CONFIG_ETH_USE_ESP32_EMAC`, RMII, lwIP and mDNS. |
| Network output task | `firmware/player_app/net_output.{h,cpp}` | Its own task, below the transmit task in priority. The render task snapshots the network channels' pixels, with brightness and colour correction applied as on the strip path, into a double buffer. The task sends one UDP socket's packets to each target. If a frame is still being sent when the next one is ready, the older frame is dropped, so the network can never stall the strips or the render loop. |
| Discovery | `firmware/player_app/wled_discovery.cpp` | An mDNS PTR query for `_wled._tcp` on the Ethernet netif, then `GET /json/info` on each result for the name, LED count, MAC and version. Runs on its own task; the arm answers with what has been found so far after waiting up to `timeout_ms`. |
| LED index space | `firmware/player/src/lib.rs`, `main.cpp` | Today the core and the render loop add up only channels 0–1. Channels 2–7 join the total (`total_with`, `apply_led_count`, `seed_led_count`, and the frame split in `main.cpp`). The strips take the first `count0 + count1` LEDs, and each network channel takes its range after them. Network channels are not bound by `max_leds_per_channel` (the WS2812 wire-time cap), only by `max_leds`. |
| Core fix found on the way | `firmware/player/src/lib.rs` `set_hardware_config` | The GPIO range check is the C6's `0..=30`. It rejects P4 header pins 32–52, which `board_caps_p4.textproto` recommends. The check moves to "a pin the board caps list". |

**Timing.** DDP frames go out on the same frame boundary as the strips. One frame of 1680 LEDs is
4 packets, about 5 KB, which is 1.6 Mbit/s at 40 fps: nothing for 100 Mbit Ethernet. The network
channels' "wire time" is the UDP send time, not 30 µs per LED, so a network-only fixture is not
bounded by the WS2812 length cap (`max_leds_per_channel`). It is still bounded by `max_leds`
(render and RAM).

## 4. App (Hardware Setup page, `web/src/ui/screens/hardwareSetup.ts`)

Shown only when the board reports `ethernet` caps:

1. **Ethernet.** An enable switch, a PHY model picker (with the board's default preselected),
   pins (MDC, MDIO, reset, RMII clock mode), and address mode: DHCP client, static, or "LED
   network" (a DHCP server, like the Mac's en15 at 192.168.50.1). Live status shows link,
   speed, IP and the last error.
2. **WLED controllers.** A _Discover_ button lists the boards found (name, IP, LED count). Picking
   one adds a network output with that board's LED count prefilled.
3. **Outputs.** Every channel in index order, each a GPIO strip or a network target, with its LED
   count, so the user sees how the global LED range is split. Mapping already counts and maps
   the whole range.

## 5. Stages

1. **Done.** Protocol, `//firmware/netout` and the core's network channels, all host-tested.
2. **Done, untested on hardware.** P4 Ethernet bring-up (`eth_p4`), the network output task
   (`net_output`) and the glue (`netout_app`, `main.cpp` under `LM_NETOUT`). Builds for `esp32p4`.
3. **Done, untested on hardware.** Discovery (`wled_discovery`) and the Hardware Setup sections
   (`web/src/ui/screens/hardwareSetupEthernet.ts`, `web/src/net/ethernet.ts`).
4. **Next: HITL.** Put a P4 with a PHY on the bench network next to a WLED board. Run the same
   check as on the Mac (WLED reports `live: true, lm: DDP`), then discovery, then a mapping capture
   through the network output. Things to watch:
   - the PHY's MDIO address and reset pin on the actual module;
   - the RMII clock direction;
   - whether `esp_eth_driver_install` failing really means "no PHY" (`phy_not_found`);
   - DHCP-server leases reaching WLED;
   - the sender task's priority under a heavy effect.

**Not done yet:**
- LED counting (`set_counting_pattern`) on a network channel: the probe only drives the GPIO
  channels. The WLED board's own LED count comes from discovery instead.
- A subnet probe for boards with mDNS turned off. Today they are added by address.

## 6. Open questions

- **Which board.** The configured board (Waveshare ESP32-P4-WIFI6) seems to have no PHY. Its
  RMII-capable GPIOs (28–31, 49–52) are free header pins. Bench options: a P4-NANO /
  P4-Module-DEV-KIT (IP101, plus a C6), or an add-on LAN8720 / RTL8201 module wired to those
  header pins.
- **Sync across boards.** DDP PUSH makes each board latch its own frame. Boards latch within the
  UDP send spread, well under a millisecond on a switch. If that's not enough, use DDP's
  broadcast-PUSH-only packet (WLED supports it) after all targets are sent.
- **Art-Net / sACN.** The `protocol` field leaves room. DDP only for now.
