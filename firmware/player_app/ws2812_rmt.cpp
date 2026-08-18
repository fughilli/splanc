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
uint8_t *g_grb = nullptr;  // R,G,B -> G,R,B reorder scratch (max_leds*3)
uint32_t g_max_leds = 0;
rmt_transmit_config_t g_txcfg = {};

bool make_channel(int gpio, int idx) {
  rmt_tx_channel_config_t chan_cfg = {};
  chan_cfg.gpio_num = static_cast<gpio_num_t>(gpio);
  chan_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
  chan_cfg.resolution_hz = kResolutionHz;
  // On-chip symbol ring; the encoder refills it on interrupt (no DMA — the C6
  // has a single DMA-capable RMT channel, and interrupt streaming is ample).
  chan_cfg.mem_block_symbols = 64;
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

}  // namespace

bool ws2812_rmt_init(int gpio0, int gpio1, uint32_t max_leds) {
  if (g_n_chan) return true;  // idempotent
  g_grb = static_cast<uint8_t *>(malloc(static_cast<size_t>(max_leds) * 3));
  if (!g_grb) return false;
  g_max_leds = max_leds;

  if (!make_channel(gpio0, 0)) return false;
  g_n_chan = 1;
  if (gpio1 >= 0) {
    if (!make_channel(gpio1, 1)) return false;
    g_n_chan = 2;
  }

  // Hold the lines LOW after the last bit: the inter-frame idle (the render
  // period, ms >> 50 us) is the WS2812 reset that latches this frame.
  g_txcfg.loop_count = 0;
  g_txcfg.flags.eot_level = 0;
  return true;
}

void ws2812_rmt_show(const uint8_t *rgb, uint32_t count0, uint32_t count1) {
  if (!g_n_chan) return;
  if (g_n_chan < 2) count1 = 0;  // no channel 1 configured
  uint32_t total = count0 + count1;
  if (total > g_max_leds) return;
  for (uint32_t i = 0; i < total; i++) {
    g_grb[3 * i + 0] = rgb[3 * i + 1];  // G
    g_grb[3 * i + 1] = rgb[3 * i + 0];  // R
    g_grb[3 * i + 2] = rgb[3 * i + 2];  // B
  }
  // Kick both channels, THEN wait — so they clock out in parallel.
  bool tx1 = count1 > 0 && g_chan[1];
  if (count0 > 0) {
    rmt_transmit(g_chan[0], g_encoder[0], g_grb, static_cast<size_t>(count0) * 3, &g_txcfg);
  }
  if (tx1) {
    rmt_transmit(g_chan[1], g_encoder[1], g_grb + static_cast<size_t>(count0) * 3,
                 static_cast<size_t>(count1) * 3, &g_txcfg);
  }
  if (count0 > 0) rmt_tx_wait_all_done(g_chan[0], -1);
  if (tx1) rmt_tx_wait_all_done(g_chan[1], -1);
}
