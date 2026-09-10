#include "firmware/player_app/mini_board.h"
#include "firmware/player_app/mini_power_policy.h"
#include "firmware/player_app/boards/splanc_mini.h"
#include <Arduino.h>
#include <esp32-hal-i2c.h>
#include <atomic>
#include <cstring>

namespace {
std::atomic<uint32_t> budget_mw{0};
std::atomic<bool> frame_overload{false};
bool bus_ready = false;
bool reg_read(uint8_t address, uint8_t reg, uint8_t *bytes, size_t n) {
  size_t got = 0;
  return bus_ready && i2cWriteReadNonStop(0, address, &reg, 1, bytes, n, 20, &got) == ESP_OK && got == n;
}
bool word(uint8_t address, uint8_t reg, uint16_t &value) {
  uint8_t b[2];
  if (!reg_read(address, reg, b, 2)) return false;
  value = (uint16_t(b[0]) << 8) | b[1];
  return true;
}
uint32_t le32(const uint8_t *p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
splanc_mini::Contract contract() {
  uint8_t p[7], r[5], p2[7], r2[5];
  if (!reg_read(0x20, 0x34, p, 7) || !reg_read(0x20, 0x35, r, 5) ||
      !reg_read(0x20, 0x34, p2, 7) || !reg_read(0x20, 0x35, r2, 5) ||
      p[0] != 6 || r[0] != 4 || memcmp(p, p2, 7) || memcmp(r, r2, 5)) return {};
  return splanc_mini::fixed_contract(le32(p + 1), le32(r + 1));
}
bool monitor(uint8_t address, uint32_t &mv, int32_t &ma) {
  uint16_t manufacturer, die, config, bus, shunt;
  if (!word(address, 0xFE, manufacturer) || manufacturer != 0x5449 ||
      !word(address, 0xFF, die) || (die & 0xFFF0) != 0x2260 ||
      !word(address, 0, config) || config != 0x4127 ||
      !word(address, 2, bus) || !word(address, 1, shunt)) return false;
  // INA226: 1.25 mV bus LSB, 2.5 uV shunt LSB; populated shunt is 10 mOhm.
  mv = uint32_t(bus) * 5 / 4;
  ma = int16_t(shunt) / 4;
  return true;
}
void outputs(bool enabled) {
  digitalWrite(SPLANC_LOAD_SW0_EN_PIN, enabled ? HIGH : LOW);
  digitalWrite(SPLANC_LOAD_SW1_EN_PIN, enabled ? HIGH : LOW);
  digitalWrite(SPLANC_STATUS_LED_PIN, enabled ? LOW : HIGH);
}
void power_task(void *) {
  bool armed = false, was_pressed = false;
  unsigned healthy_samples = 0;
  uint32_t previous_mv = 0, previous_ma = 0;
  vTaskDelay(pdMS_TO_TICKS(300));
  for (;;) {
    auto c = contract();
    if (c.millivolts != previous_mv || c.milliamps != previous_ma) {
      armed = false;
      healthy_samples = 0;
    }
    previous_mv = c.millivolts;
    previous_ma = c.milliamps;
    uint32_t v0 = 0, v1 = 0;
    int32_t i0 = 0, i1 = 0;
    bool fresh = monitor(0x40, v0, i0) && monitor(0x41, v1, i1);
    bool healthy = splanc_mini::load_allowed(c, fresh,
        digitalRead(SPLANC_LOAD_SW0_FLT_PIN) == LOW,
        digitalRead(SPLANC_LOAD_SW1_FLT_PIN) == LOW, v0, v1, i0, i1);
    if (frame_overload.exchange(false)) healthy = false;
    if (!healthy) { armed = false; healthy_samples = 0; }
    else if (healthy_samples < 3) ++healthy_samples;
    bool pressed = digitalRead(SPLANC_USER_BTN1_PIN) == LOW;
    // Deliberate bench arming. Faults/source changes require another press.
    if (pressed && !was_pressed && healthy_samples >= 3) armed = !armed;
    was_pressed = pressed;
    const uint32_t next = armed ? c.led_budget_mw : 0;
    budget_mw.store(next);
    outputs(next != 0);
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}
}  // namespace

void mini_board_init() {
  outputs(false);
  pinMode(SPLANC_USER_BTN1_PIN, INPUT_PULLUP);
  pinMode(SPLANC_USER_BTN2_PIN, INPUT_PULLUP);
  bus_ready = i2cInit(0, SPLANC_I2C_SDA_PIN, SPLANC_I2C_SCL_PIN, 100000) == ESP_OK;
  if (bus_ready) xTaskCreate(power_task, "mini-power", 4096, nullptr, 3, nullptr);
}

void mini_limit_frame(uint8_t *rgb, uint32_t n0, uint32_t n1) {
  if (!splanc_mini::limit_frame(rgb, n0, n1, budget_mw.load())) frame_overload.store(true);
}
