// ESP32-C6 WS2812 backend: the PARLIO TX unit clocks a pre-encoded frame out of
// RAM by GDMA (see ws2812.h for why: the RMT backend's interrupt-refilled ring
// glitched on the wire whenever an ISR ran late).
//
// Encoding: PARLIO shifts one sample per lane per clock at kSampleHz = 2.5 MHz
// (PLL_F240M / 96, an exact integer divider), and each WS2812 bit is three
// 400 ns samples — the RMT backend's timing exactly:
//   bit0 = 1 0 0  -> 0.4 us high, 0.8 us low
//   bit1 = 1 1 0  -> 0.8 us high, 0.4 us low
// Every bit ends low, so the line rests low after the last bit and the
// inter-frame idle latches the frame.
//
// The staged frame lives in one static buffer sized for LM_MAX_LEDS on one lane
// (9 bytes per LED; on the C6 all HP SRAM is DMA-capable and the netstack build
// runs close to empty, so this replaces main.cpp's show_buf snapshot rather than
// adding to it). It is staged in one of three layouts:
//   * one live channel: a single-lane transfer on that channel's GPIO;
//   * two channels whose longer one fits half the buffer: a 2-bit-wide transfer,
//     lane k on channel k's GPIO, both clocking out in parallel (18 bytes per LED
//     of the longer channel; the shorter lane pads with low samples);
//   * two longer channels: two single-lane blocks sent back to back, re-routing
//     the unit's data line between the GPIOs. Still DMA, just not parallel.
#include <driver/gpio.h>
#include <driver/parlio_tx.h>
#include <esp_rom_gpio.h>
#include <soc/gpio_sig_map.h>

#include <array>
#include <cstring>

#include "firmware/player_app/ws2812.h"

#ifndef LM_MAX_LEDS
#error "LM_MAX_LEDS must be defined by the build — see //firmware/player_app:led_caps.bzl"
#endif

namespace {

constexpr uint32_t kSampleHz = 2500 * 1000;
constexpr int kMaxChannels = 2;
constexpr size_t kBytesPerLedLane = 9;  // 24 bits x 3 samples / 8
// Every transfer is padded with low samples to a 4-byte boundary plus one more
// word: unpadded, the last samples of a frame whose length wasn't a multiple of
// 4 bytes came out corrupted on ~28% of frames (a stretched HIGH 6 bits from
// the end, seen on the analyzer as trailing partial bits).
constexpr size_t kTailPad = 4;
constexpr size_t padded(size_t bytes) {
  return ((bytes + 3) & ~static_cast<size_t>(3)) + kTailPad;
}
constexpr size_t kFrameBytes = static_cast<size_t>(LM_MAX_LEDS) * kBytesPerLedLane;
// Room for the sequential layout's two padded blocks.
constexpr size_t kBufBytes = padded(kFrameBytes) + padded(0);
// Longest channel a parallel (2-lane) frame can carry.
constexpr uint32_t kMaxParallelLeds = kFrameBytes / (2 * kBytesPerLedLane);

// One wire byte -> its 24 samples, first-transmitted sample in bit 0 (the unit
// packs LSB-first). The byte goes MSB-first, as WS2812 shifts it.
constexpr std::array<uint32_t, 256> kSamples = [] {
  std::array<uint32_t, 256> t{};
  for (uint32_t b = 0; b < 256; b++) {
    uint32_t w = 0;
    for (uint32_t j = 0; j < 8; j++) {
      const uint32_t bit = (b >> (7 - j)) & 1;
      w |= (1u | (bit << 1)) << (3 * j);  // samples 1, bit, 0
    }
    t[b] = w;
  }
  return t;
}();

// 8 one-lane samples -> 16 bits with each sample at an even bit (lane 0); OR
// in another lane's spread shifted left one for lane 1.
constexpr std::array<uint16_t, 256> kSpread = [] {
  std::array<uint16_t, 256> t{};
  for (uint32_t b = 0; b < 256; b++) {
    uint16_t w = 0;
    for (uint32_t j = 0; j < 8; j++) w |= static_cast<uint16_t>(((b >> j) & 1) << (2 * j));
    t[b] = w;
  }
  return t;
}();

alignas(4) uint8_t g_buf[kBufBytes];

// What's staged in g_buf.
enum class Layout { kNone, kSingle, kParallel, kSequential };
Layout g_layout = Layout::kNone;
int g_single_ch = 0;          // kSingle: the live channel
size_t g_bytes[2] = {0, 0};   // unpadded bytes: [0] = whole transfer or block 0, [1] = block 1
size_t g_block1_off = 0;      // kSequential: where block 1 starts

parlio_tx_unit_handle_t g_unit = nullptr;
int g_width = 0;  // data width of g_unit (1 or 2), 0 = none
int g_routed = -1;  // width-1 unit: the channel its data line is routed to
int g_gpio[kMaxChannels] = {-1, -1};
int g_n_chan = 0;
uint32_t g_max_leds = 0;
esp_err_t g_last_tx[kMaxChannels] = {ESP_OK, ESP_OK};

// Per-channel wire color order as a SOURCE permutation (see ws2812.h). Default
// GRB {1, 0, 2}.
uint8_t g_order[kMaxChannels][3] = {{1, 0, 2}, {1, 0, 2}};

parlio_transmit_config_t g_txcfg = {};

void drop_unit() {
  if (!g_unit) return;
  parlio_tx_unit_disable(g_unit);
  parlio_del_tx_unit(g_unit);
  g_unit = nullptr;
  g_width = 0;
  g_routed = -1;
}

// Park a GPIO as a plain output driven low (an idle WS2812 line).
void park_low(int gpio) {
  if (gpio < 0) return;
  esp_rom_gpio_connect_out_signal(gpio, SIG_GPIO_OUT_IDX, false, false);
  gpio_set_direction(static_cast<gpio_num_t>(gpio), GPIO_MODE_OUTPUT);
  gpio_set_level(static_cast<gpio_num_t>(gpio), 0);
}

// (Re)create the unit at `width` lanes. Width 1 starts on channel 0's GPIO
// (route() moves it); width 2 drives both.
esp_err_t ensure_unit(int width) {
  if (g_unit && g_width == width) return ESP_OK;
  drop_unit();
  parlio_tx_unit_config_t cfg = {};
  cfg.clk_src = PARLIO_CLK_SRC_DEFAULT;
  cfg.clk_in_gpio_num = GPIO_NUM_NC;
  cfg.output_clk_freq_hz = kSampleHz;
  cfg.data_width = static_cast<size_t>(width);
  for (auto &g : cfg.data_gpio_nums) g = GPIO_NUM_NC;
  cfg.data_gpio_nums[0] = static_cast<gpio_num_t>(g_gpio[0]);
  if (width == 2) cfg.data_gpio_nums[1] = static_cast<gpio_num_t>(g_gpio[1]);
  cfg.clk_out_gpio_num = GPIO_NUM_NC;
  cfg.valid_gpio_num = GPIO_NUM_NC;
  cfg.trans_queue_depth = 2;
  cfg.max_transfer_size = kBufBytes;
  cfg.sample_edge = PARLIO_SAMPLE_EDGE_POS;
  cfg.bit_pack_order = PARLIO_BIT_PACK_ORDER_LSB;
  esp_err_t err = parlio_new_tx_unit(&cfg, &g_unit);
  if (err != ESP_OK) {
    g_unit = nullptr;
    return err;
  }
  err = parlio_tx_unit_enable(g_unit);
  if (err != ESP_OK) {
    drop_unit();
    return err;
  }
  g_width = width;
  if (width == 1) {
    g_routed = 0;
    park_low(g_gpio[1]);
  }
  return ESP_OK;
}

// Route the width-1 unit's data line to channel `ch`'s GPIO, parking the other.
void route(int ch) {
  if (g_routed == ch) return;
  park_low(g_gpio[ch ^ 1]);
  esp_rom_gpio_connect_out_signal(g_gpio[ch], PARL_TX_DATA0_IDX, false, false);
  g_routed = ch;
}

// One lane: `n` pixels from `rgb` in wire order `ord` -> n * 9 bytes.
void encode_lane(uint8_t *dst, const uint8_t *rgb, uint32_t n, const uint8_t *ord) {
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t *px = &rgb[3 * i];
    for (int k = 0; k < 3; k++) {
      const uint32_t s = kSamples[px[ord[k]]];
      *dst++ = static_cast<uint8_t>(s);
      *dst++ = static_cast<uint8_t>(s >> 8);
      *dst++ = static_cast<uint8_t>(s >> 16);
    }
  }
}

// Two lanes interleaved, `len` = the longer channel; past its own count a lane
// is all-low samples (not zero BITS, which would still pulse high).
void encode_two(uint8_t *dst, uint32_t len, const uint8_t *rgb0, uint32_t n0, const uint8_t *ord0,
                const uint8_t *rgb1, uint32_t n1, const uint8_t *ord1) {
  for (uint32_t i = 0; i < len; i++) {
    for (int k = 0; k < 3; k++) {
      const uint32_t s0 = i < n0 ? kSamples[rgb0[3 * i + ord0[k]]] : 0;
      const uint32_t s1 = i < n1 ? kSamples[rgb1[3 * i + ord1[k]]] : 0;
      for (int b = 0; b < 3; b++) {
        const uint16_t w = kSpread[(s0 >> (8 * b)) & 0xff] |
                           static_cast<uint16_t>(kSpread[(s1 >> (8 * b)) & 0xff] << 1);
        *dst++ = static_cast<uint8_t>(w);
        *dst++ = static_cast<uint8_t>(w >> 8);
      }
    }
  }
}

// Zero a block's tail pad (all-low samples on every lane).
void pad_block(uint8_t *block, size_t bytes) { memset(block + bytes, 0, padded(bytes) - bytes); }

// Transmit `bytes` (+ pad) from `block`, blocking until the DMA is done.
esp_err_t transmit(const uint8_t *block, size_t bytes) {
  esp_err_t err = parlio_tx_unit_transmit(g_unit, block, padded(bytes) * 8, &g_txcfg);
  if (err == ESP_OK) err = parlio_tx_unit_wait_all_done(g_unit, -1);
  return err;
}

}  // namespace

bool ws2812_init(int gpio0, int gpio1, uint32_t max_leds) {
  if (g_n_chan) return true;  // idempotent
  if (max_leds > static_cast<uint32_t>(LM_MAX_LEDS)) return false;
  g_max_leds = max_leds;
  g_txcfg.idle_value = 0;
  return ws2812_reconfigure(gpio0, gpio1);
}

void ws2812_set_color_order(int ch, uint8_t s0, uint8_t s1, uint8_t s2) {
  if (ch < 0 || ch >= kMaxChannels) return;
  g_order[ch][0] = s0;
  g_order[ch][1] = s1;
  g_order[ch][2] = s2;
}

bool ws2812_reconfigure(int gpio0, int gpio1) {
  if (!g_max_leds) return false;  // never init'd
  drop_unit();
  for (int i = 0; i < kMaxChannels; i++) park_low(g_gpio[i]);
  g_gpio[0] = gpio0;
  g_gpio[1] = gpio1;
  g_n_chan = 0;
  // Bring the unit up now (single lane) so a peripheral failure surfaces here,
  // like the RMT backend's channel creation.
  const esp_err_t err = ensure_unit(1);
  g_last_tx[0] = err;
  if (err != ESP_OK) return false;
  g_n_chan = gpio1 >= 0 ? 2 : 1;
  return true;
}

void ws2812_stage(const uint8_t *rgb, uint32_t count0, uint32_t count1,
                  const uint8_t *order_override) {
  g_layout = Layout::kNone;
  if (!g_n_chan) return;
  if (g_n_chan < 2) count1 = 0;  // no channel 1 configured
  if (count0 + count1 > g_max_leds) return;
  const uint8_t *ord0 = order_override ? order_override : g_order[0];
  const uint8_t *ord1 = order_override ? order_override : g_order[1];
  const uint8_t *rgb1 = rgb + static_cast<size_t>(count0) * 3;

  if (count0 == 0 || count1 == 0) {
    const uint32_t n = count0 ? count0 : count1;
    if (n == 0) return;
    g_single_ch = count0 ? 0 : 1;
    g_bytes[0] = static_cast<size_t>(n) * kBytesPerLedLane;
    encode_lane(g_buf, count0 ? rgb : rgb1, n, count0 ? ord0 : ord1);
    pad_block(g_buf, g_bytes[0]);
    g_layout = Layout::kSingle;
    return;
  }
  const uint32_t len = count0 > count1 ? count0 : count1;
  if (len <= kMaxParallelLeds) {
    g_bytes[0] = static_cast<size_t>(len) * 2 * kBytesPerLedLane;
    encode_two(g_buf, len, rgb, count0, ord0, rgb1, count1, ord1);
    pad_block(g_buf, g_bytes[0]);
    g_layout = Layout::kParallel;
    return;
  }
  g_bytes[0] = static_cast<size_t>(count0) * kBytesPerLedLane;
  g_bytes[1] = static_cast<size_t>(count1) * kBytesPerLedLane;
  g_block1_off = padded(g_bytes[0]);
  encode_lane(g_buf, rgb, count0, ord0);
  pad_block(g_buf, g_bytes[0]);
  encode_lane(g_buf + g_block1_off, rgb1, count1, ord1);
  pad_block(g_buf + g_block1_off, g_bytes[1]);
  g_layout = Layout::kSequential;
}

void ws2812_send(void) {
  switch (g_layout) {
    case Layout::kNone:
      return;
    case Layout::kSingle: {
      esp_err_t err = ensure_unit(1);
      if (err == ESP_OK) {
        route(g_single_ch);
        err = transmit(g_buf, g_bytes[0]);
      }
      g_last_tx[g_single_ch] = err;
      return;
    }
    case Layout::kParallel: {
      esp_err_t err = ensure_unit(2);
      if (err == ESP_OK) err = transmit(g_buf, g_bytes[0]);
      g_last_tx[0] = g_last_tx[1] = err;
      return;
    }
    case Layout::kSequential: {
      esp_err_t err = ensure_unit(1);
      if (err == ESP_OK) {
        route(0);
        err = transmit(g_buf, g_bytes[0]);
      }
      g_last_tx[0] = err;
      if (err != ESP_OK) return;
      route(1);
      g_last_tx[1] = transmit(g_buf + g_block1_off, g_bytes[1]);
      return;
    }
  }
}

void ws2812_show(const uint8_t *rgb, uint32_t count0, uint32_t count1,
                 const uint8_t *order_override) {
  ws2812_stage(rgb, count0, count1, order_override);
  ws2812_send();
}

int ws2812_channels(void) { return g_n_chan; }
int ws2812_last_error(int ch) {
  return (ch >= 0 && ch < kMaxChannels) ? static_cast<int>(g_last_tx[ch]) : -1;
}
const char *ws2812_backend(void) { return "parlio"; }
