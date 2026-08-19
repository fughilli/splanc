#include "firmware/player_app/ws2812_rmt.h"

#include <driver/rmt_encoder.h>
#include <driver/rmt_tx.h>
#include <stdlib.h>

namespace {

// 0.1 us / tick. WS2812B bit cells discriminate 0 vs 1 by HIGH time; the low
// tails just pad the ~1.25 us cell. At this resolution (within the WS2812
// ±150 ns tolerance):
//   bit0 = 0.4 us high, 0.8 us low   (T0H≈0.4, T0L≈0.85)
//   bit1 = 0.8 us high, 0.4 us low   (T1H≈0.8, T1L≈0.45)
constexpr uint32_t kResolutionHz = 10 * 1000 * 1000;
constexpr uint16_t kT0H = 4, kT0L = 8, kT1H = 8, kT1L = 4;
constexpr int kMaxChannels = 2;

// One channel + its own encoder (each channel needs a distinct encoder — the
// bytes encoder is stateful, and the two channels transmit concurrently).
rmt_channel_handle_t g_chan[kMaxChannels] = {nullptr, nullptr};
rmt_encoder_handle_t g_encoder[kMaxChannels] = {nullptr, nullptr};
int g_n_chan = 0;
uint8_t *g_grb = nullptr;  // reordered wire scratch (max_leds*3)
uint32_t g_max_leds = 0;
rmt_transmit_config_t g_txcfg = {};
esp_err_t g_last_tx[kMaxChannels] = {ESP_OK, ESP_OK};  // last rmt_transmit result / channel

// Per-channel wire color order as a SOURCE permutation of the R,G,B input:
// wire byte i is written from rgb[g_order[ch][i]]. Default GRB {1, 0, 2} — the
// WS2812B order (wire = G, R, B). set_hardware_config overrides it per channel.
uint8_t g_order[kMaxChannels][3] = {{1, 0, 2}, {1, 0, 2}};

bool make_channel(int gpio, int idx) {
  rmt_tx_channel_config_t chan_cfg = {};
  chan_cfg.gpio_num = static_cast<gpio_num_t>(gpio);
  chan_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
  chan_cfg.resolution_hz = kResolutionHz;
  // On-chip symbol ring; the encoder refills it on interrupt (no DMA — the C6
  // has a single DMA-capable RMT channel, and interrupt streaming is ample).
  // Cap at 48 = the C6's per-channel RMT memory block (SOC_RMT_MEM_WORDS_PER_
  // CHANNEL). Asking for more makes channel 0 borrow into channel 1's block, so
  // allocating the 2nd TX channel then fails (rmt_new_tx_channel -> ESP_ERR_NOT_
  // FOUND) and only 1 channel comes up. 48 symbols is ample: the bytes encoder
  // refills the ring on interrupt, it just refills a little more often.
  chan_cfg.mem_block_symbols = 48;
  chan_cfg.trans_queue_depth = 4;
  if (rmt_new_tx_channel(&chan_cfg, &g_chan[idx]) != ESP_OK) return false;

  rmt_bytes_encoder_config_t enc_cfg = {};
  enc_cfg.bit0.level0 = 1;
  enc_cfg.bit0.duration0 = kT0H;
  enc_cfg.bit0.level1 = 0;
  enc_cfg.bit0.duration1 = kT0L;
  enc_cfg.bit1.level0 = 1;
  enc_cfg.bit1.duration0 = kT1H;
  enc_cfg.bit1.level1 = 0;
  enc_cfg.bit1.duration1 = kT1L;
  enc_cfg.flags.msb_first = 1;  // WS2812 shifts each byte MSB-first
  if (rmt_new_bytes_encoder(&enc_cfg, &g_encoder[idx]) != ESP_OK) return false;

  return rmt_enable(g_chan[idx]) == ESP_OK;
}

// Build channel 0 (and channel 1 if gpio1 >= 0), setting g_n_chan. Assumes the
// channel slots are empty (fresh init, or after teardown_channels). Returns
// false on the first peripheral/allocation failure.
bool build_channels(int gpio0, int gpio1) {
  if (!make_channel(gpio0, 0)) return false;
  g_n_chan = 1;
  if (gpio1 >= 0) {
    if (!make_channel(gpio1, 1)) return false;
    g_n_chan = 2;
  }
  return true;
}

// Disable + delete every live channel and its encoder (for reconfigure). Leaves
// g_n_chan == 0. The scratch buffer / color orders / txcfg are preserved.
void teardown_channels() {
  for (int i = 0; i < kMaxChannels; i++) {
    if (g_chan[i]) {
      rmt_disable(g_chan[i]);
      rmt_del_channel(g_chan[i]);
      g_chan[i] = nullptr;
    }
    if (g_encoder[i]) {
      rmt_del_encoder(g_encoder[i]);
      g_encoder[i] = nullptr;
    }
  }
  g_n_chan = 0;
}

}  // namespace

bool ws2812_rmt_init(int gpio0, int gpio1, uint32_t max_leds) {
  if (g_n_chan) return true;  // idempotent
  g_grb = static_cast<uint8_t *>(malloc(static_cast<size_t>(max_leds) * 3));
  if (!g_grb) return false;
  g_max_leds = max_leds;

  if (!build_channels(gpio0, gpio1)) return false;

  // Hold the lines LOW after the last bit: the inter-frame idle (the render
  // period, ms >> 50 us) is the WS2812 reset that latches this frame.
  g_txcfg.loop_count = 0;
  g_txcfg.flags.eot_level = 0;
  return true;
}

void ws2812_rmt_set_color_order(int ch, uint8_t s0, uint8_t s1, uint8_t s2) {
  if (ch < 0 || ch >= kMaxChannels) return;
  g_order[ch][0] = s0;
  g_order[ch][1] = s1;
  g_order[ch][2] = s2;
}

bool ws2812_rmt_reconfigure(int gpio0, int gpio1) {
  if (!g_grb) return false;  // never init'd — nothing to reconfigure
  teardown_channels();
  return build_channels(gpio0, gpio1);
}

void ws2812_rmt_show(const uint8_t *rgb, uint32_t count0, uint32_t count1) {
  if (!g_n_chan) return;
  if (g_n_chan < 2) count1 = 0;  // no channel 1 configured
  uint32_t total = count0 + count1;
  if (total > g_max_leds) return;
  // Reorder each pixel to its channel's wire color order. Channel 0 owns pixels
  // [0, count0); channel 1 owns [count0, total) — so a per-channel order applies
  // to the right span even though both share one contiguous buffer.
  for (uint32_t i = 0; i < total; i++) {
    const uint8_t *ord = g_order[i < count0 ? 0 : 1];
    const uint8_t *in = &rgb[3 * i];
    g_grb[3 * i + 0] = in[ord[0]];
    g_grb[3 * i + 1] = in[ord[1]];
    g_grb[3 * i + 2] = in[ord[2]];
  }
  // Kick both channels, THEN wait — so they clock out in parallel.
  bool tx1 = count1 > 0 && g_chan[1];
  if (count0 > 0) {
    g_last_tx[0] = rmt_transmit(g_chan[0], g_encoder[0], g_grb, static_cast<size_t>(count0) * 3,
                               &g_txcfg);
  }
  if (tx1) {
    g_last_tx[1] = rmt_transmit(g_chan[1], g_encoder[1], g_grb + static_cast<size_t>(count0) * 3,
                                static_cast<size_t>(count1) * 3, &g_txcfg);
  }
  if (count0 > 0) rmt_tx_wait_all_done(g_chan[0], -1);
  if (tx1) rmt_tx_wait_all_done(g_chan[1], -1);
}

int ws2812_rmt_channels(void) { return g_n_chan; }
int ws2812_rmt_last_error(int ch) {
  return (ch >= 0 && ch < kMaxChannels) ? static_cast<int>(g_last_tx[ch]) : -1;
}
