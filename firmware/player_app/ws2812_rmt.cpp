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

rmt_channel_handle_t g_chan = nullptr;
rmt_encoder_handle_t g_encoder = nullptr;
uint8_t *g_grb = nullptr;  // R,G,B -> G,R,B reorder scratch (max_leds*3)
uint32_t g_max_leds = 0;
rmt_transmit_config_t g_txcfg = {};

}  // namespace

bool ws2812_rmt_init(int gpio, uint32_t max_leds) {
  if (g_chan) return true;  // idempotent
  g_grb = static_cast<uint8_t *>(malloc(static_cast<size_t>(max_leds) * 3));
  if (!g_grb) return false;
  g_max_leds = max_leds;

  rmt_tx_channel_config_t chan_cfg = {};
  chan_cfg.gpio_num = static_cast<gpio_num_t>(gpio);
  chan_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
  chan_cfg.resolution_hz = kResolutionHz;
  // On-chip symbol ring; the encoder refills it on interrupt (no DMA — the C6
  // has a single DMA-capable RMT channel, and interrupt streaming is ample for
  // a ~7.7 ms/256-LED push that already yields the core to the render task).
  chan_cfg.mem_block_symbols = 64;
  chan_cfg.trans_queue_depth = 4;
  if (rmt_new_tx_channel(&chan_cfg, &g_chan) != ESP_OK) return false;

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
  if (rmt_new_bytes_encoder(&enc_cfg, &g_encoder) != ESP_OK) return false;

  if (rmt_enable(g_chan) != ESP_OK) return false;

  // Hold the line LOW after the last bit: the inter-frame idle (the render
  // period, ms >> 50 us) is the WS2812 reset that latches this frame.
  g_txcfg.loop_count = 0;
  g_txcfg.flags.eot_level = 0;
  return true;
}

void ws2812_rmt_show(const uint8_t *rgb, uint32_t n) {
  if (!g_chan || n > g_max_leds) return;
  for (uint32_t i = 0; i < n; i++) {
    g_grb[3 * i + 0] = rgb[3 * i + 1];  // G
    g_grb[3 * i + 1] = rgb[3 * i + 0];  // R
    g_grb[3 * i + 2] = rgb[3 * i + 2];  // B
  }
  if (rmt_transmit(g_chan, g_encoder, g_grb, static_cast<size_t>(n) * 3, &g_txcfg) != ESP_OK) {
    return;
  }
  rmt_tx_wait_all_done(g_chan, -1);  // block THIS task until the frame is clocked out
}
