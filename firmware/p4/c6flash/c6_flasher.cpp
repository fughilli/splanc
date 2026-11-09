// See c6_flasher.h. The SDIO register map and the SIP / stub packet conventions follow
// esp-serial-flasher's protocol_sdio.c (Apache-2.0), which was the reference; the code
// here is ours.
#include "firmware/p4/c6flash/c6_flasher.h"

#include <driver/gpio.h>
#include <driver/sdmmc_host.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <sdmmc_cmd.h>
#include <string.h>

extern "C" {
extern const unsigned char c6_stub_text[];
extern const unsigned char c6_stub_data[];
extern const uint32_t c6_stub_text_len, c6_stub_data_len, c6_stub_text_start, c6_stub_data_start, c6_stub_entry;
}

namespace {

// --- SDIO / SLC registers of the C6 (function 1 addresses) ---------------------------
constexpr uint32_t kStateW0 = 0x64;   // SLCHOST_STATE_W0: register-window read data
constexpr uint32_t kConfW5 = 0x80;    // SLCHOST_CONF_W5: register-window write data + cmd
constexpr uint32_t kWinCmd = 0x84;    // SLCHOST_WIN_CMD
constexpr uint32_t kPacketSpaceEnd = 0x1f800;  // a packet of n bytes is written at end - n
constexpr uint32_t kSlcConf1 = 0x70;  // SLC registers, through the window
constexpr uint32_t kSlcLenConf = 0xF4;
constexpr uint32_t kTxStitch = 1u << 5, kRxStitch = 1u << 6, kTxPacketLoad = 1u << 24;
// The stub's mailbox (function 1).
constexpr uint32_t kTokenRdata = 0x44;  // bits 16..27: receive buffers free (512 B each)
constexpr uint32_t kIntSt = 0x58;
constexpr uint32_t kIntClr = 0xD4;
constexpr uint32_t kConfW0 = 0x6C;      // the stub's outgoing packet length
constexpr uint32_t kIntNewPacket = 1u << 23;
constexpr uint32_t kMaxTransaction = 16647;
constexpr size_t kBlock = 512;

// --- SIP (the ROM's SDIO boot protocol) ----------------------------------------------
constexpr size_t kSipPacket = 256;
constexpr uint8_t kSipCmdWriteMemory = 1, kSipCmdBootup = 5, kSipFlagSync = 0x4;
struct __attribute__((packed)) SipHeader {
  uint8_t fc[2];
  uint16_t len;  // whole packet, multiple of 4
  uint32_t cmdid;
  uint32_t seq;
};

// --- esptool commands (stub) ---------------------------------------------------------
enum : uint8_t { kFlashDeflBegin = 0x10, kFlashDeflData = 0x11, kFlashDeflEnd = 0x12, kSpiFlashMd5 = 0x13 };
struct __attribute__((packed)) CmdHeader {
  uint8_t direction;  // 0 = to the target
  uint8_t command;
  uint16_t size;      // bytes after this header
  uint32_t checksum;
};

struct Ctx {
  sdmmc_card_t card;
  int (*log)(const char*, ...);
  uint32_t sip_seq;
  uint8_t* dma;  // kMaxTransaction + slack, DMA-capable
  uint32_t block;  // flash data per FLASH_DEFL_DATA: what the stub's receive buffers hold
};

#define LOG(c, ...) \
  do {               \
    if ((c).log) (c).log(__VA_ARGS__); \
  } while (0)

esp_err_t rd(Ctx& c, uint32_t fn, uint32_t addr, void* out, size_t n) {
  esp_err_t e = sdmmc_io_read_bytes(&c.card, fn, addr, c.dma, n);
  if (e == ESP_OK) memcpy(out, c.dma, n);
  return e;
}

esp_err_t wr(Ctx& c, uint32_t fn, uint32_t addr, const void* in, size_t n) {
  memcpy(c.dma, in, n);
  return sdmmc_io_write_bytes(&c.card, fn, addr, c.dma, n);
}

bool wait_ready(Ctx& c, int timeout_ms) {
  const int64_t end = esp_timer_get_time() + timeout_ms * 1000LL;
  do {
    uint8_t r = 0;
    if (sdmmc_io_read_byte(&c.card, 0, 0x03, &r) == ESP_OK && (r & 0x02)) return true;
  } while (esp_timer_get_time() < end);
  return false;
}

esp_err_t win_read(Ctx& c, uint32_t reg, uint32_t* v) {
  const uint8_t b[4] = {(uint8_t)((reg >> 2) & 0x7f), 0x80, 0, 0};
  esp_err_t e = wr(c, 1, kWinCmd, b, sizeof b);
  return e == ESP_OK ? rd(c, 1, kStateW0, v, 4) : e;
}

esp_err_t win_write(Ctx& c, uint32_t reg, uint32_t v) {
  uint8_t b[8] = {};
  memcpy(b, &v, 4);
  b[4] = (reg >> 2) & 0x7f;
  b[5] = 0xC0;
  return wr(c, 1, kConfW5, b, sizeof b);
}

void set_pins(const C6Pins& p, bool download) {
  gpio_reset_pin((gpio_num_t)p.en);
  gpio_reset_pin((gpio_num_t)p.boot);
  gpio_set_direction((gpio_num_t)p.en, GPIO_MODE_OUTPUT);
  gpio_set_level((gpio_num_t)p.en, 0);
  if (download) {
    gpio_set_direction((gpio_num_t)p.boot, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)p.boot, 0);
  } else {
    gpio_set_direction((gpio_num_t)p.boot, GPIO_MODE_INPUT);
  }
  vTaskDelay(pdMS_TO_TICKS(50));
  gpio_set_level((gpio_num_t)p.en, 1);
  vTaskDelay(pdMS_TO_TICKS(100));  // the straps are latched at reset
  gpio_set_direction((gpio_num_t)p.boot, GPIO_MODE_INPUT);
}

bool host_up(Ctx& c, const C6Pins& p) {
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.slot = SDMMC_HOST_SLOT_1;
  host.max_freq_khz = SDMMC_FREQ_DEFAULT;
  host.flags = SDMMC_HOST_FLAG_4BIT | SDMMC_HOST_FLAG_ALLOC_ALIGNED_BUF;
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.clk = (gpio_num_t)p.clk;
  slot.cmd = (gpio_num_t)p.cmd;
  slot.d0 = (gpio_num_t)p.d0;
  slot.d1 = (gpio_num_t)p.d1;
  slot.d2 = (gpio_num_t)p.d2;
  slot.d3 = (gpio_num_t)p.d3;
  slot.d4 = slot.d5 = slot.d6 = slot.d7 = GPIO_NUM_NC;
  slot.width = 4;
  slot.flags = SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
  if (sdmmc_host_init() != ESP_OK || sdmmc_host_init_slot(SDMMC_HOST_SLOT_1, &slot) != ESP_OK) return false;
  for (int i = 0; i < 5; i++) {
    memset(&c.card, 0, sizeof c.card);
    if (sdmmc_card_init(&host, &c.card) == ESP_OK) return true;
    vTaskDelay(pdMS_TO_TICKS(100));
  }
  return false;
}

// Function 1 on, and the SLC set up for packets (stitching, TX packet load).
bool link_up(Ctx& c) {
  if (!wait_ready(c, 200)) return false;
  uint8_t en = 0;
  if (sdmmc_io_read_byte(&c.card, 0, 0x02, &en) != ESP_OK) return false;
  en |= 0x02;
  if (sdmmc_io_write_byte(&c.card, 0, 0x02, en, nullptr) != ESP_OK) return false;
  // Who is there: the CIS's manufacturer tuple (0x20) says Espressif (0x0092) and the
  // chip (0x100D = C6).
  uint8_t p[3];
  for (int i = 0; i < 3; i++) sdmmc_io_read_byte(&c.card, 0, 0x09 + i, &p[i]);
  uint32_t cis = p[0] | p[1] << 8 | p[2] << 16;
  for (uint32_t a = cis; a < cis + 32;) {
    uint8_t code = 0, len = 0;
    sdmmc_io_read_byte(&c.card, 0, a, &code);
    sdmmc_io_read_byte(&c.card, 0, a + 1, &len);
    if (code == 0x20 && len == 4) {
      uint8_t id[4];
      for (int i = 0; i < 4; i++) sdmmc_io_read_byte(&c.card, 0, a + 2 + i, &id[i]);
      LOG(c, "c6flash: SDIO vendor 0x%04x device 0x%04x\n", id[0] | id[1] << 8, id[2] | id[3] << 8);
      break;
    }
    a += 2 + len;
  }
  uint32_t r = 0;
  if (!wait_ready(c, 200) || win_read(c, kSlcConf1, &r) != ESP_OK) return false;
  if (win_write(c, kSlcConf1, r | kTxStitch | kRxStitch) != ESP_OK) return false;
  uint32_t back = 0;
  if (win_read(c, kSlcConf1, &back) != ESP_OK || back != (r | kTxStitch | kRxStitch)) return false;
  if (!wait_ready(c, 200) || win_read(c, kSlcLenConf, &r) != ESP_OK) return false;
  return win_write(c, kSlcLenConf, r | kTxPacketLoad) == ESP_OK;
}

bool sip_write_memory(Ctx& c, uint32_t addr, const uint8_t* data, uint32_t size) {
  if (!wait_ready(c, 200)) return false;
  uint8_t pkt[kSipPacket];
  constexpr uint32_t kOverhead = sizeof(SipHeader) + 8;
  for (uint32_t done = 0; done < size;) {
    uint32_t n = size - done < kSipPacket - kOverhead ? size - done : kSipPacket - kOverhead;
    n = (n + 3) & ~3u;
    SipHeader h = {};
    h.fc[0] = 0;  // CTRL
    h.len = (uint16_t)(kOverhead + n);
    h.cmdid = kSipCmdWriteMemory;
    h.seq = c.sip_seq++;
    const uint32_t cmd[2] = {addr + done, n};
    memset(pkt, 0, sizeof pkt);
    memcpy(pkt, &h, sizeof h);
    memcpy(pkt + sizeof h, cmd, sizeof cmd);
    memcpy(pkt + kOverhead, data + done, size - done < n ? size - done : n);
    if (wr(c, 1, kPacketSpaceEnd - h.len, pkt, h.len) != ESP_OK) return false;
    done += n;
  }
  return true;
}

bool sip_bootup(Ctx& c, uint32_t entry) {
  if (!wait_ready(c, 200)) return false;
  SipHeader h = {};
  h.fc[1] = kSipFlagSync;
  h.len = sizeof(SipHeader) + 8;
  h.cmdid = kSipCmdBootup;
  uint8_t pkt[sizeof(SipHeader) + 8];
  const uint32_t cmd[2] = {entry, 1};  // boot address, discard the link
  memcpy(pkt, &h, sizeof h);
  memcpy(pkt + sizeof h, cmd, sizeof cmd);
  return wr(c, 1, kPacketSpaceEnd - h.len, pkt, h.len) == ESP_OK;
}

// One packet from the stub (a response, or its "OHAI" hello).
int stub_read(Ctx& c, uint8_t* out, size_t cap, int timeout_ms) {
  const int64_t end = esp_timer_get_time() + timeout_ms * 1000LL;
  uint32_t st = 0;
  while (true) {
    if (rd(c, 1, kIntSt, &st, 4) != ESP_OK) return -1;
    if (st & kIntNewPacket) break;
    if (esp_timer_get_time() > end) return -2;
    vTaskDelay(1);
  }
  uint32_t n = 0;
  if (rd(c, 1, kConfW0, &n, 4) != ESP_OK) return -1;
  const uint32_t clr = kIntNewPacket;
  if (n == 0 || n > cap) {
    wr(c, 1, kIntClr, &clr, 4);
    return -3;
  }
  for (uint32_t got = 0; got < n;) {
    const size_t k = n - got < kBlock ? n - got : kBlock;
    if (rd(c, 1, kPacketSpaceEnd - n + got, out + got, k) != ESP_OK) return -1;
    got += k;
  }
  wr(c, 1, kIntClr, &clr, 4);
  return (int)n;
}

uint8_t checksum(const uint8_t* p, size_t n) {
  uint8_t s = 0xEF;
  while (n--) s ^= *p++;
  return s;
}

// One esptool command (header + args, then optional data) and its response. On success
// copies any response data (between the 8-byte header and the 2-byte status) to `resp`.
int stub_cmd(Ctx& c, uint8_t command, const void* args, size_t args_len, const uint8_t* data, size_t data_len,
             uint8_t* resp, size_t resp_cap, int timeout_ms) {
  CmdHeader h = {0, command, (uint16_t)(args_len + data_len), data ? checksum(data, data_len) : 0u};
  const size_t total = sizeof h + args_len + data_len;
  if (total > kMaxTransaction) return -10;
  // Room in the stub's receive buffers: it frees them as it erases and writes, so a
  // block can wait as long as the command itself.
  const int64_t end = esp_timer_get_time() + timeout_ms * 1000LL;
  while (true) {
    uint32_t tok = 0;
    if (rd(c, 1, kTokenRdata, &tok, 4) != ESP_OK) return -11;
    if (((tok >> 16) & 0x0fff) * kBlock >= total) break;
    if (esp_timer_get_time() > end) return -12;
    vTaskDelay(1);
  }
  // Stage the whole packet, then write it in 512-byte pieces from end - total upward.
  uint8_t* pkt = static_cast<uint8_t*>(heap_caps_malloc(total, MALLOC_CAP_DEFAULT));
  if (!pkt) return -13;
  memcpy(pkt, &h, sizeof h);
  memcpy(pkt + sizeof h, args, args_len);
  if (data_len) memcpy(pkt + sizeof h + args_len, data, data_len);
  const uint32_t base = kPacketSpaceEnd - total;
  int rc = 0;
  for (size_t off = 0; off < total && rc == 0;) {
    const size_t k = total - off < kBlock ? total - off : kBlock;
    if (wr(c, 1, base + off, pkt + off, k) != ESP_OK) rc = -14;
    off += k;
  }
  heap_caps_free(pkt);
  if (rc) return rc;
  uint8_t r[8 + 64 + 2];
  const int n = stub_read(c, r, sizeof r, timeout_ms);
  if (n < 10) return n < 0 ? n : -15;
  if (r[0] != 1 || r[1] != command) return -16;
  if (r[n - 2] != 0) {
    LOG(c, "c6flash: command 0x%02x failed, error 0x%02x\n", command, r[n - 1]);
    return -17;
  }
  const size_t rn = (size_t)n - 10;
  if (resp) memcpy(resp, r + 8, rn < resp_cap ? rn : resp_cap);
  return (int)rn;
}

struct Image {
  uint32_t offset, size, zsize;
  const uint8_t* md5;
  const uint8_t* z;
};

int write_image(Ctx& c, const Image& im) {
  const uint32_t blocks = (im.zsize + c.block - 1) / c.block;
  const uint32_t begin[4] = {im.size, blocks, c.block, im.offset};
  // Erase happens in begin: allow ~3 s per MB.
  int rc = stub_cmd(c, kFlashDeflBegin, begin, sizeof begin, nullptr, 0, nullptr, 0, 1000 + 3 * (int)(im.size >> 10));
  if (rc < 0) return rc;
  for (uint32_t b = 0; b < blocks; b++) {
    const uint32_t off = b * c.block;
    const uint32_t n = im.zsize - off < c.block ? im.zsize - off : c.block;
    const uint32_t args[4] = {n, b, 0, 0};
    rc = stub_cmd(c, kFlashDeflData, args, sizeof args, im.z + off, n, nullptr, 0, 10000);
    if (rc < 0) {
      LOG(c, "c6flash: block %u/%u at 0x%x: %d\n", (unsigned)b, (unsigned)blocks, (unsigned)im.offset, rc);
      return rc;
    }
  }
  const uint32_t md5args[4] = {im.offset, im.size, 0, 0};
  uint8_t md5[16];
  rc = stub_cmd(c, kSpiFlashMd5, md5args, sizeof md5args, nullptr, 0, md5, sizeof md5, 5000 + (int)(im.size >> 10) * 4);
  if (rc < 16) return rc < 0 ? rc : -18;
  if (memcmp(md5, im.md5, 16) != 0) {
    LOG(c, "c6flash: MD5 mismatch at 0x%x\n", (unsigned)im.offset);
    return -19;
  }
  return 0;
}

uint32_t le32(const uint8_t* p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

}  // namespace

const uint8_t* c6_bundle_app_sha(const C6Bundle& b) {
  if (b.len < 40 || memcmp(b.data, "C6B1", 4) != 0) return nullptr;
  return b.data + 8;
}

void c6_reset_normal(const C6Pins& pins) { set_pins(pins, false); }

int c6_flash(const C6Pins& pins, const C6Bundle& bundle, int (*log)(const char*, ...)) {
  Ctx c = {};
  c.log = log;
  if (!c6_bundle_app_sha(bundle)) {
    LOG(c, "c6flash: not a C6 bundle\n");
    return -1;
  }
  const uint32_t count = le32(bundle.data + 4);
  c.dma = static_cast<uint8_t*>(heap_caps_malloc(kMaxTransaction + 64, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  if (!c.dma) return -2;
  int rc = 0;
  const int64_t t0 = esp_timer_get_time();
  set_pins(pins, true);
  if (!host_up(c, pins)) {
    LOG(c, "c6flash: no SDIO answer from the C6 ROM\n");
    rc = -3;
  } else if (!link_up(c)) {
    LOG(c, "c6flash: SDIO link setup failed\n");
    rc = -4;
  } else if (!sip_write_memory(c, c6_stub_text_start, c6_stub_text, c6_stub_text_len) ||
             (c6_stub_data_len && !sip_write_memory(c, c6_stub_data_start, c6_stub_data, c6_stub_data_len)) ||
             !sip_bootup(c, c6_stub_entry)) {
    LOG(c, "c6flash: stub upload failed\n");
    rc = -5;
  } else {
    uint8_t ohai[8];
    const int n = stub_read(c, ohai, sizeof ohai, 1000);
    if (n != 4 || memcmp(ohai, "OHAI", 4) != 0) {
      LOG(c, "c6flash: the stub didn't start (%d)\n", n);
      rc = -6;
    } else {
      // Size the data blocks to the stub's receive buffers (512 B each), less the command
      // header and arguments, in whole KB.
      uint32_t tok = 0;
      rd(c, 1, kTokenRdata, &tok, 4);
      const uint32_t room = ((tok >> 16) & 0x0fff) * kBlock;
      c.block = room > 1024 + 64 ? ((room - 64) / 1024) * 1024 : 1024;
      if (c.block > 0x4000) c.block = 0x4000;
      LOG(c, "c6flash: stub running (%u ms); %u B of receive buffers, %u B blocks\n",
          (unsigned)((esp_timer_get_time() - t0) / 1000), (unsigned)room, (unsigned)c.block);
      const uint8_t* entry = bundle.data + 40;
      const uint8_t* z = entry + count * 28;
      for (uint32_t i = 0; i < count && rc == 0; i++, entry += 28) {
        Image im = {le32(entry), le32(entry + 4), le32(entry + 8), entry + 12, z};
        z += im.zsize;
        const int64_t t = esp_timer_get_time();
        rc = write_image(c, im);
        LOG(c, "c6flash: 0x%06x %u B (%u compressed): %s, %u ms\n", (unsigned)im.offset, (unsigned)im.size,
            (unsigned)im.zsize, rc == 0 ? "written, MD5 ok" : "FAILED", (unsigned)((esp_timer_get_time() - t) / 1000));
        if (rc) rc = -100 + rc;
      }
    }
  }
  sdmmc_host_deinit();
  heap_caps_free(c.dma);
  set_pins(pins, false);  // boot whatever is in flash now
  LOG(c, "c6flash: %s in %u ms\n", rc == 0 ? "done" : "failed", (unsigned)((esp_timer_get_time() - t0) / 1000));
  return rc;
}
