// Network LED outputs over DDP: see net_output.h.
#include "net_output.h"

// Arduino.h (via serial_log.h) before any lwIP header: IPAddress.h clashes
// with lwIP macros otherwise.
#include "serial_log.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "eth_p4.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

namespace {

struct Frame {
  uint32_t counts[NET_OUTPUT_CHANNELS];  // LEDs per channel
  uint32_t offset[NET_OUTPUT_CHANNELS];  // byte offset of each channel in `rgb`
  uint8_t *rgb;
};

constexpr uint32_t kKeepaliveMs = 1000;  // WLED's realtime timeout is 2.5 s
constexpr UBaseType_t kPriority = 9;     // below render (10) and transmit (11)
constexpr uint32_t kStackBytes = 4096;

portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
Frame s_frames[3];
// Triple buffer: render fills s_frames[s_w], publishes it as s_ready; the sender
// takes s_ready as s_s. Indices swap under s_mux.
int s_w = 0, s_ready = 1, s_s = 2;
bool s_fresh = false;
uint32_t s_cap_bytes = 0;

NetoutTarget s_targets[NET_OUTPUT_CHANNELS] = {};
volatile bool s_active = false;

TaskHandle_t s_task = nullptr;
volatile uint32_t s_tx_frames = 0, s_tx_errors = 0;
uint8_t s_seq[NET_OUTPUT_CHANNELS] = {};

int s_sock = -1;

bool send_frame(const Frame &f, const NetoutTarget (&t)[NET_OUTPUT_CHANNELS]) {
  if (s_sock < 0) {
    s_sock = lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) return false;
    int one = 1;
    lwip_setsockopt(s_sock, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);  // a /24 broadcast target
  }
  // Big enough for either protocol: DDP 1450 B, ArtDmx 528 B.
  static uint8_t pkt[NETOUT_DDP_MAX_PACKET > NETOUT_ARTNET_MAX_PACKET ? NETOUT_DDP_MAX_PACKET
                                                                      : NETOUT_ARTNET_MAX_PACKET];
  bool any = false;
  for (int ch = 0; ch < NET_OUTPUT_CHANNELS; ch++) {
    if (t[ch].ip == 0 || f.counts[ch] == 0) continue;
    sockaddr_in to = {};
    to.sin_family = AF_INET;
    to.sin_port = eth_to_nbo16(t[ch].port);
    to.sin_addr.s_addr = eth_to_nbo32(t[ch].ip);
    const uint8_t *data = f.rgb + f.offset[ch];
    const size_t len = (size_t)f.counts[ch] * 3;
    auto send = [&](const uint8_t *buf, size_t n) {
      if (lwip_sendto(s_sock, buf, n, 0, reinterpret_cast<sockaddr *>(&to), sizeof to) < 0) {
        s_tx_errors = s_tx_errors + 1;
        return false;  // the rest of this frame would go the same way (no route / no buffers)
      }
      return true;
    };
    if (t[ch].protocol == NETOUT_PROTOCOL_ARTNET) {
      s_seq[ch] = netout_artnet_next_seq(s_seq[ch]);
      const size_t n = netout_artnet_packet_count(len);
      bool ok = true;
      for (size_t i = 0; i < n && ok; i++) {
        const size_t plen = netout_artnet_packet(data, len, i, t[ch].universe, s_seq[ch], pkt, sizeof pkt);
        ok = plen != 0 && send(pkt, plen);
      }
      if (ok && t[ch].sync) {
        const size_t plen = netout_artnet_sync(pkt, sizeof pkt);
        if (plen) send(pkt, plen);
      }
    } else {
      s_seq[ch] = netout_ddp_next_seq(s_seq[ch]);
      const size_t n = netout_ddp_packet_count(len);
      for (size_t i = 0; i < n; i++) {
        const size_t plen = netout_ddp_packet(data, len, i, s_seq[ch], pkt, sizeof pkt);
        if (plen == 0 || !send(pkt, plen)) break;
      }
    }
    any = true;
  }
  return any;
}

void sender_task(void *) {
  bool have = false;
  for (;;) {
    const bool notified = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(kKeepaliveMs)) != 0;
    NetoutTarget t[NET_OUTPUT_CHANNELS];
    taskENTER_CRITICAL(&s_mux);
    if (s_fresh) {
      const int x = s_s;
      s_s = s_ready;
      s_ready = x;
      s_fresh = false;
      have = true;
    }
    memcpy(t, s_targets, sizeof t);
    taskEXIT_CRITICAL(&s_mux);
    // No new frame: resend the last one (keepalive), if there is one.
    if (!have || (!notified && !s_active)) continue;
    if (!eth_p4_ready()) continue;
    if (send_frame(s_frames[s_s], t)) s_tx_frames = s_tx_frames + 1;
  }
}

}  // namespace

bool net_output_begin(uint32_t max_leds) {
  if (s_task) return true;
  s_cap_bytes = max_leds * 3;
  for (Frame &f : s_frames) {
    f.rgb = static_cast<uint8_t *>(heap_caps_calloc(1, s_cap_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!f.rgb) f.rgb = static_cast<uint8_t *>(heap_caps_calloc(1, s_cap_bytes, MALLOC_CAP_8BIT));
    if (!f.rgb) {
      Log().printf("[net] %u B frame buffers FAILED\n", (unsigned)s_cap_bytes);
      return false;
    }
  }
  if (xTaskCreatePinnedToCore(sender_task, "net_out", kStackBytes, nullptr, kPriority, &s_task,
                              tskNO_AFFINITY) != pdPASS) {
    Log().printf("[net] sender task FAILED\n");
    return false;
  }
  Log().printf("[net] output ready: up to %u LEDs, 3 x %u B\n", (unsigned)max_leds, (unsigned)s_cap_bytes);
  return true;
}

void net_output_set_targets(const NetoutTarget targets[NET_OUTPUT_CHANNELS]) {
  bool any = false;
  taskENTER_CRITICAL(&s_mux);
  for (int i = 0; i < NET_OUTPUT_CHANNELS; i++) {
    s_targets[i] = targets[i];
    any = any || targets[i].ip != 0;
  }
  taskEXIT_CRITICAL(&s_mux);
  s_active = any;
}

bool net_output_active(void) { return s_active && s_task != nullptr; }

void net_output_submit(const uint8_t *rgb, uint32_t net_base,
                       const uint32_t counts[NET_OUTPUT_CHANNELS],
                       const uint8_t perms[NET_OUTPUT_CHANNELS][3], uint32_t rendered) {
  if (!net_output_active()) return;
  Frame &f = s_frames[s_w];
  uint32_t at = 0;            // bytes into f.rgb
  uint32_t led = net_base;    // global LED index of this channel's first LED
  for (int ch = 0; ch < NET_OUTPUT_CHANNELS; ch++) {
    uint32_t n = counts[ch];
    if ((at + n * 3) > s_cap_bytes) n = (s_cap_bytes - at) / 3;  // clamp to the buffers
    f.counts[ch] = n;
    f.offset[ch] = at;
    // LEDs [led, led + n) of the frame; those at or past `rendered` are black.
    const uint32_t drawn = rendered > led ? (rendered - led < n ? rendered - led : n) : 0;
    const uint8_t *p = perms[ch];
    if (drawn && p[0] == 0 && p[1] == 1 && p[2] == 2) {
      memcpy(f.rgb + at, rgb + (size_t)led * 3, (size_t)drawn * 3);
    } else if (drawn) {
      const uint8_t *src = rgb + (size_t)led * 3;
      uint8_t *dst = f.rgb + at;
      for (uint32_t k = 0; k < drawn; k++, src += 3, dst += 3) {
        dst[0] = src[p[0] % 3];
        dst[1] = src[p[1] % 3];
        dst[2] = src[p[2] % 3];
      }
    }
    if (drawn < n) memset(f.rgb + at + drawn * 3, 0, (size_t)(n - drawn) * 3);
    at += n * 3;
    led += counts[ch];
  }
  taskENTER_CRITICAL(&s_mux);
  const int x = s_ready;
  s_ready = s_w;
  s_w = x;
  s_fresh = true;
  taskEXIT_CRITICAL(&s_mux);
  xTaskNotifyGive(s_task);
}

void net_output_counters(uint32_t *frames, uint32_t *errors) {
  if (frames) *frames = s_tx_frames;
  if (errors) *errors = s_tx_errors;
}
