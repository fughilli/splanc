// Ethernet on the ESP32-P4: see eth_p4.h and docs/design/p4-ethernet-ddp.md.
#include "eth_p4.h"

// Arduino.h (via serial_log.h) before any lwIP header: IPAddress.h clashes
// with lwIP macros otherwise.
#include "serial_log.h"

#include <string.h>

#include "esp_eth.h"
#include "esp_eth_mac_esp.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif.h"

namespace {

esp_eth_handle_t s_eth = nullptr;
esp_eth_mac_t *s_mac = nullptr;
esp_eth_phy_t *s_phy = nullptr;
esp_netif_t *s_netif = nullptr;
esp_eth_netif_glue_handle_t s_glue = nullptr;
bool s_stack_ready = false;
bool s_handlers = false;

// Written by the event task, read anywhere: single words.
volatile bool s_link = false;
volatile uint32_t s_speed = 0;
volatile bool s_full_duplex = false;
const char *s_error = "";

// The netif's static address (static and DHCP-server modes), kept alive for
// esp_netif_inherent_config_t.ip_info.
esp_netif_ip_info_t s_ip_info = {};

void on_eth_event(void *, esp_event_base_t, int32_t id, void *data) {
  esp_eth_handle_t h = data ? *static_cast<esp_eth_handle_t *>(data) : nullptr;
  switch (id) {
    case ETHERNET_EVENT_CONNECTED: {
      eth_speed_t sp = ETH_SPEED_10M;
      eth_duplex_t dup = ETH_DUPLEX_HALF;
      if (h) {
        esp_eth_ioctl(h, ETH_CMD_G_SPEED, &sp);
        esp_eth_ioctl(h, ETH_CMD_G_DUPLEX_MODE, &dup);
      }
      s_speed = sp == ETH_SPEED_100M ? 100 : 10;
      s_full_duplex = dup == ETH_DUPLEX_FULL;
      s_link = true;
      Log().printf("[eth] link up %u Mbps %s duplex\n", (unsigned)s_speed, s_full_duplex ? "full" : "half");
      break;
    }
    case ETHERNET_EVENT_DISCONNECTED:
      s_link = false;
      Log().printf("[eth] link down\n");
      break;
    default:
      break;
  }
}

void on_ip_event(void *, esp_event_base_t, int32_t id, void *data) {
  if (id == IP_EVENT_ETH_GOT_IP && data) {
    const ip_event_got_ip_t *e = static_cast<const ip_event_got_ip_t *>(data);
    Log().printf("[eth] got ip " IPSTR "/" IPSTR " gw " IPSTR "\n", IP2STR(&e->ip_info.ip),
           IP2STR(&e->ip_info.netmask), IP2STR(&e->ip_info.gw));
  }
}

bool ensure_stack() {
  if (s_stack_ready) return true;
  esp_err_t e = esp_netif_init();
  if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) return false;
  // The Arduino core may already have made the default loop.
  e = esp_event_loop_create_default();
  if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) return false;
  if (!s_handlers) {
    esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_eth_event, nullptr);
    esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_ip_event, nullptr);
    s_handlers = true;
  }
  s_stack_ready = true;
  return true;
}

void stop() {
  if (s_eth) {
    esp_eth_stop(s_eth);
  }
  if (s_glue) {
    esp_eth_del_netif_glue(s_glue);
    s_glue = nullptr;
  }
  if (s_netif) {
    esp_netif_destroy(s_netif);
    s_netif = nullptr;
  }
  if (s_eth) {
    esp_eth_driver_uninstall(s_eth);
    s_eth = nullptr;
  }
  if (s_phy) {
    s_phy->del(s_phy);
    s_phy = nullptr;
  }
  if (s_mac) {
    s_mac->del(s_mac);
    s_mac = nullptr;
  }
  s_link = false;
  s_speed = 0;
}

esp_eth_phy_t *new_phy(uint8_t phy, const eth_phy_config_t &c) {
  switch (phy) {
    case 1: return esp_eth_phy_new_ip101(&c);
    case 2: return esp_eth_phy_new_lan87xx(&c);  // LAN8720 is a LAN87xx
    case 3: return esp_eth_phy_new_rtl8201(&c);
    case 4: return esp_eth_phy_new_dp83848(&c);
    case 5: return esp_eth_phy_new_ksz80xx(&c);
    default: return nullptr;
  }
}

esp_ip4_addr_t addr(uint32_t be) {
  esp_ip4_addr_t a;
  a.addr = eth_to_nbo32(be);
  return a;
}

}  // namespace

const char *eth_p4_apply(const NetoutEthConfig &cfg) {
  stop();
  s_error = "";
  if (!cfg.enabled) {
    Log().printf("[eth] off\n");
    return nullptr;
  }
  if (!ensure_stack()) return s_error = "netif";

  eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
  // ETH_ESP32_EMAC_DEFAULT_CONFIG() lists its designators out of declaration
  // order, which C++ refuses, so the same values field by field. The RMII data
  // pins are the IDF's P4 IO MUX defaults (netout's RMII_GPIOS); SMI and the
  // clock come from the config.
  eth_esp32_emac_config_t emac = {};
  emac.interface = EMAC_DATA_INTERFACE_RMII;
  emac.dma_burst_len = ETH_DMA_BURST_LEN_32;
  emac.intr_priority = 0;
  emac.mdc_freq_hz = 0;
  emac.emac_dataif_gpio.rmii.tx_en_num = 49;
  emac.emac_dataif_gpio.rmii.txd0_num = 34;
  emac.emac_dataif_gpio.rmii.txd1_num = 35;
  emac.emac_dataif_gpio.rmii.crs_dv_num = 28;
  emac.emac_dataif_gpio.rmii.rxd0_num = 29;
  emac.emac_dataif_gpio.rmii.rxd1_num = 30;
  emac.clock_config_out_in.rmii.clock_mode = EMAC_CLK_EXT_IN;
  emac.clock_config_out_in.rmii.clock_gpio = (emac_rmii_clock_gpio_t)-1;
  emac.smi_gpio.mdc_num = cfg.mdc;
  emac.smi_gpio.mdio_num = cfg.mdio;
  if (cfg.clock == 1) {
    // The P4 makes the 50 MHz clock on clock_gpio; the EMAC still reads it back
    // on GPIO50, so the board must loop clock_gpio to GPIO50.
    emac.clock_config.rmii.clock_mode = EMAC_CLK_OUT;
    emac.clock_config.rmii.clock_gpio = (emac_rmii_clock_gpio_t)cfg.clock_gpio;
    emac.clock_config_out_in.rmii.clock_mode = EMAC_CLK_EXT_IN;
    emac.clock_config_out_in.rmii.clock_gpio = (emac_rmii_clock_gpio_t)50;
  } else {
    emac.clock_config.rmii.clock_mode = EMAC_CLK_EXT_IN;
    emac.clock_config.rmii.clock_gpio = (emac_rmii_clock_gpio_t)50;
  }
  s_mac = esp_eth_mac_new_esp32(&emac, &mac_config);
  if (!s_mac) {
    stop();
    return s_error = "emac_init";
  }
  eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
  phy_config.phy_addr = cfg.phy_addr < 0 ? ESP_ETH_PHY_ADDR_AUTO : cfg.phy_addr;
  phy_config.reset_gpio_num = cfg.reset;
  s_phy = new_phy(cfg.phy, phy_config);
  if (!s_phy) {
    stop();
    return s_error = "bad_phy";
  }
  esp_eth_config_t config = ETH_DEFAULT_CONFIG(s_mac, s_phy);
  esp_err_t e = esp_eth_driver_install(&config, &s_eth);
  if (e != ESP_OK) {
    // The install resets and reads the PHY: a wrong address, model or wiring
    // fails here.
    Log().printf("[eth] driver install failed: %s\n", esp_err_to_name(e));
    s_eth = nullptr;  // install frees nothing on failure; mac / phy still ours
    stop();
    return s_error = "phy_not_found";
  }

  esp_netif_inherent_config_t base = ESP_NETIF_INHERENT_DEFAULT_ETH();
  s_ip_info.ip = addr(cfg.ip);
  s_ip_info.netmask = addr(cfg.netmask);
  s_ip_info.gw = addr(cfg.gateway);
  if (cfg.ip_mode == 2) {
    // The LED network's DHCP server: our address is static, leases go out to
    // the controllers.
    base.flags = (esp_netif_flags_t)(ESP_NETIF_DHCP_SERVER | ESP_NETIF_FLAG_AUTOUP);
    base.ip_info = &s_ip_info;
    base.get_ip_event = 0;
    base.lost_ip_event = 0;
  }
  esp_netif_config_t ncfg = {};
  ncfg.base = &base;
  ncfg.driver = nullptr;
  ncfg.stack = ESP_NETIF_NETSTACK_DEFAULT_ETH;
  s_netif = esp_netif_new(&ncfg);
  if (!s_netif) {
    stop();
    return s_error = "netif";
  }
  if (cfg.ip_mode == 1) {
    esp_netif_dhcpc_stop(s_netif);
    esp_netif_set_ip_info(s_netif, &s_ip_info);
  }
  s_glue = esp_eth_new_netif_glue(s_eth);
  if (!s_glue || esp_netif_attach(s_netif, s_glue) != ESP_OK) {
    stop();
    return s_error = "netif";
  }
  e = esp_eth_start(s_eth);
  if (e != ESP_OK) {
    Log().printf("[eth] start failed: %s\n", esp_err_to_name(e));
    stop();
    return s_error = "emac_init";
  }
  static const char *const kModes[] = {"dhcp client", "static", "dhcp server"};
  Log().printf("[eth] up: phy %u addr %d mdc %d mdio %d rst %d clk %s, %s " IPSTR "\n", cfg.phy,
         cfg.phy_addr, cfg.mdc, cfg.mdio, cfg.reset, cfg.clock == 1 ? "out" : "in",
         kModes[cfg.ip_mode < 3 ? cfg.ip_mode : 0], IP2STR(&s_ip_info.ip));
  return nullptr;
}

void eth_p4_status(NetoutLinkStatus *st) {
  if (!st) return;
  memset(st, 0, sizeof *st);
  st->link_up = s_link ? 1 : 0;
  st->speed_mbps = s_link ? s_speed : 0;
  st->full_duplex = s_link && s_full_duplex ? 1 : 0;
  if (s_netif) {
    esp_netif_ip_info_t ip = {};
    if (esp_netif_get_ip_info(s_netif, &ip) == ESP_OK) {
      st->ip = eth_from_nbo32(ip.ip.addr);
      st->netmask = eth_from_nbo32(ip.netmask.addr);
      st->gateway = eth_from_nbo32(ip.gw.addr);
    }
  }
  if (s_eth) {
    esp_eth_ioctl(s_eth, ETH_CMD_G_MAC_ADDR, st->mac);
  } else {
    esp_read_mac(st->mac, ESP_MAC_ETH);
  }
}

const char *eth_p4_error(void) { return s_error; }

uint32_t eth_p4_ip_nbo(void) {
  if (!s_netif) return 0;
  esp_netif_ip_info_t ip = {};
  if (esp_netif_get_ip_info(s_netif, &ip) != ESP_OK) return 0;
  return ip.ip.addr;
}

bool eth_p4_ready(void) { return s_link && eth_p4_ip_nbo() != 0; }
