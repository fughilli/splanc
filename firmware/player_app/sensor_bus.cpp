// Sensor core, C++ side: see sensor_bus.h and docs/design/sensor-core.md.
#include "sensor_bus.h"

#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/i2c_master.h>
#include <esp_cpu.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <nvs.h>

#include "player_ffi.h"
#include "serial_log.h"

namespace {

// 400 kHz: the MPU-6050's fast mode. A FIFO drain of 2 samples is ~0.8 ms of
// bus time; the i2c_master driver is interrupt-driven, so the task blocks on a
// semaphore during the transfer and the CPU stays free.
constexpr uint32_t kI2cHz = 400000;
// Per-transaction timeout. A NACK aborts after the address byte; this only
// bounds a stuck/stretched bus.
constexpr int kXferTimeoutMs = 10;
// Below the render (10) and netstack loop (10) tasks: the FIFO buffers
// >400 ms of samples, so being preempted by a long frame costs latency, never
// data or dt accuracy (sample timing comes from the IMU clock).
constexpr UBaseType_t kSensorTaskPrio = 5;
// Static-bound-checked (stack_bound.json "sensor"); heap-allocated only when a
// sensor is present. Static bound 1,056 B (1,640 B with the 1.25 margin).
static const uint32_t kSensorTaskStack = 2560;

i2c_master_bus_handle_t g_bus = nullptr;
// Device handles per 7-bit address, created lazily (only 0x68/0x69 are used).
struct DevSlot {
  uint8_t addr;
  i2c_master_dev_handle_t dev;
};
DevSlot g_devs[2] = {{0, nullptr}, {0, nullptr}};
TaskHandle_t g_task = nullptr;
int g_sda = -1, g_scl = -1;

int to_ret(esp_err_t e) {
  if (e == ESP_OK) return 0;
  // i2c_master reports an address NACK as ESP_ERR_INVALID_RESPONSE (IDF 5.2+)
  // or ESP_ERR_NOT_FOUND from probe.
  if (e == ESP_ERR_INVALID_RESPONSE || e == ESP_ERR_NOT_FOUND) return 1;
  return 2;
}

i2c_master_dev_handle_t dev_for(uint8_t addr, int *ret) {
  for (auto &s : g_devs) {
    if (s.dev && s.addr == addr) return s.dev;
  }
  // First contact: probe (no allocation) before creating a device object, so
  // an absent part costs nothing but the probe.
  esp_err_t e = i2c_master_probe(g_bus, addr, kXferTimeoutMs);
  if (e != ESP_OK) {
    *ret = to_ret(e) == 2 ? 2 : 1;
    return nullptr;
  }
  for (auto &s : g_devs) {
    if (!s.dev) {
      i2c_device_config_t dc = {};
      dc.dev_addr_length = I2C_ADDR_BIT_LEN_7;
      dc.device_address = addr;
      dc.scl_speed_hz = kI2cHz;
      if (i2c_master_bus_add_device(g_bus, &dc, &s.dev) != ESP_OK) {
        s.dev = nullptr;
        *ret = 2;
        return nullptr;
      }
      s.addr = addr;
      return s.dev;
    }
  }
  *ret = 2;
  return nullptr;
}

int bus_write_read(void *, uint8_t addr, const uint8_t *wr, size_t wn, uint8_t *rd, size_t rn) {
  int ret = 0;
  i2c_master_dev_handle_t d = dev_for(addr, &ret);
  if (!d) return ret;
  return to_ret(i2c_master_transmit_receive(d, wr, wn, rd, rn, kXferTimeoutMs));
}

int bus_write(void *, uint8_t addr, const uint8_t *wr, size_t wn) {
  int ret = 0;
  i2c_master_dev_handle_t d = dev_for(addr, &ret);
  if (!d) return ret;
  return to_ret(i2c_master_transmit(d, wr, wn, kXferTimeoutMs));
}

uint32_t cycles() { return (uint32_t)esp_cpu_get_cycle_count(); }

const LmI2cOps kOps = {nullptr, bus_write_read, bus_write, cycles};

// The IMU keeps power across an ESP32 reset; a reset mid-read can leave it
// holding SDA low until it sees more clocks (indoor_localization hit this on
// its MPU-6050 nodes). Standard bus clear: clock SCL until SDA releases, then
// a STOP. Only runs when SDA is actually low (<0.2 ms).
void recover_bus(int sda, int scl) {
  gpio_set_direction((gpio_num_t)sda, GPIO_MODE_INPUT);
  gpio_set_pull_mode((gpio_num_t)sda, GPIO_PULLUP_ONLY);
  delayMicroseconds(5);
  if (gpio_get_level((gpio_num_t)sda) != 0) return;
  gpio_set_direction((gpio_num_t)scl, GPIO_MODE_INPUT_OUTPUT_OD);
  gpio_set_pull_mode((gpio_num_t)scl, GPIO_PULLUP_ONLY);
  int pulses = 0;
  for (; pulses < 18 && gpio_get_level((gpio_num_t)sda) == 0; pulses++) {
    gpio_set_level((gpio_num_t)scl, 0);
    delayMicroseconds(5);
    gpio_set_level((gpio_num_t)scl, 1);
    delayMicroseconds(5);
  }
  gpio_set_direction((gpio_num_t)sda, GPIO_MODE_INPUT_OUTPUT_OD);
  gpio_set_level((gpio_num_t)sda, 0);
  delayMicroseconds(5);
  gpio_set_level((gpio_num_t)scl, 1);
  delayMicroseconds(5);
  gpio_set_level((gpio_num_t)sda, 1);
  Log().printf("[sensor] bus clear: %d SCL pulses, sda=%d\n", pulses,
               gpio_get_level((gpio_num_t)sda));
}

void free_bus() {
  for (auto &s : g_devs) {
    if (s.dev) i2c_master_bus_rm_device(s.dev);
    s.dev = nullptr;
  }
  if (g_bus) i2c_del_master_bus(g_bus);
  g_bus = nullptr;
}

// Persist a calibration record (atomic NVS entry write; see calib.rs).
void persist_cal(const uint8_t *rec, size_t len) {
  nvs_handle_t h;
  if (nvs_open("ledmapper", NVS_READWRITE, &h) != ESP_OK) return;
  esp_err_t e = nvs_set_blob(h, "sens_cal", rec, len);
  if (e == ESP_OK) e = nvs_commit(h);
  nvs_close(h);
  Log().printf("[sensor] calibration saved (%u B) %s\n", (unsigned)len,
               e == ESP_OK ? "ok" : "FAILED");
}

void sensor_task(void *) {
  uint8_t rec[96];
  for (;;) {
    uint32_t ms = lm_sensor_poll((uint64_t)esp_timer_get_time());
    int32_t n = lm_sensor_take_cal_record(rec, sizeof rec);
    if (n > 0) persist_cal(rec, (size_t)n);
    vTaskDelay(pdMS_TO_TICKS(ms ? ms : 1));
  }
}

const char *state_name(uint32_t st) {
  switch (st) {
    case 1: return "absent";
    case 2: return "unknown-device";
    case 3: return "starting";
    case 4: return "running";
    case 5: return "fault";
    case 6: return "disabled";
    default: return "off";
  }
}

}  // namespace

void sensor_begin(bool enabled, int sda, int scl, int int_gpio, int led_gpio0, int led_gpio1,
                  const uint8_t *cal, size_t cal_len) {
  g_sda = sda;
  g_scl = scl;
  auto led = [&](int g) { return g >= 0 && (g == led_gpio0 || g == led_gpio1); };
  if (!enabled || sda < 0 || scl < 0 || sda == scl || led(sda) || led(scl)) {
    lm_sensor_set_disabled(sda, scl, int_gpio);
    Log().printf("[sensor] disabled (en=%d sda=%d scl=%d led=%d/%d): %s\n", enabled, sda, scl,
                 led_gpio0, led_gpio1, enabled ? "pin conflict with an LED output" : "off");
    return;
  }
  // An INT pin that collides with the bus or an LED output is dropped (the
  // core polls anyway), not fatal.
  if (int_gpio == sda || int_gpio == scl || led(int_gpio)) {
    Log().printf("[sensor] INT gpio %d conflicts; ignoring it (polling)\n", int_gpio);
    int_gpio = -1;
  }
  uint32_t t0 = micros();
  recover_bus(sda, scl);
  i2c_master_bus_config_t bc = {};
  bc.i2c_port = -1;  // any free HP I2C controller
  bc.sda_io_num = (gpio_num_t)sda;
  bc.scl_io_num = (gpio_num_t)scl;
  bc.clk_source = I2C_CLK_SRC_DEFAULT;
  bc.glitch_ignore_cnt = 7;
  // Breakouts (GY-521) carry 4.7k-10k pull-ups; the internal ~45k ones keep an
  // empty bus from floating during the probe.
  bc.flags.enable_internal_pullup = 1;
  if (i2c_new_master_bus(&bc, &g_bus) != ESP_OK) {
    g_bus = nullptr;
    lm_sensor_set_disabled(sda, scl, int_gpio);
    Log().printf("[sensor] i2c bus init FAILED on sda=%d scl=%d\n", sda, scl);
    return;
  }
  uint8_t st = lm_sensor_begin(&kOps, sda, scl, int_gpio, (uint64_t)esp_timer_get_time(), cal,
                               cal_len);
  uint32_t probe_us = micros() - t0;
  if (st == 3) {
    // Recognized IMU, reset issued: the task configures it once the part's
    // 100 ms reset time has passed (never blocking setup()).
    if (xTaskCreate(sensor_task, "sensor", kSensorTaskStack, nullptr, kSensorTaskPrio, &g_task) !=
        pdPASS) {
      g_task = nullptr;
      free_bus();
      lm_sensor_set_disabled(sda, scl, int_gpio);
      Log().printf("[sensor] task create FAILED (heap)\n");
      return;
    }
    Log().printf("[sensor] IMU found, starting (sda=%d scl=%d probe %u us, cal %s)\n", sda, scl,
                 (unsigned)probe_us, cal_len ? "loaded" : "none");
    return;
  }
  // Absent / unknown device / fault at boot: release everything — zero
  // residual cost (no task, no bus objects). Hot-plug isn't supported.
  free_bus();
  gpio_reset_pin((gpio_num_t)sda);
  gpio_reset_pin((gpio_num_t)scl);
  Log().printf("[sensor] %s on sda=%d scl=%d (probe %u us)\n", state_name(st), sda, scl,
               (unsigned)probe_us);
}

void sensor_log_status() {
  if (!g_task) return;
  uint32_t u[6];
  float f[5];
  lm_sensor_status(u, f);
  Log().printf("[sensor] %s addr=0x%02x who=0x%02x %s n=%u %.1fHz q=%.3f,%.3f,%.3f,%.3f "
               "cyc=%u/%u err=%u ovf=%u\n",
               state_name(u[0] & 0xFF), (unsigned)((u[0] >> 8) & 0xFF),
               (unsigned)((u[0] >> 16) & 0xFF), (u[0] >> 24) ? "fifo" : "poll", (unsigned)u[1],
               f[0], f[1], f[2], f[3], f[4], (unsigned)u[3], (unsigned)u[4], (unsigned)u[2],
               (unsigned)u[5]);
}
