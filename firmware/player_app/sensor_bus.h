// Sensor core, C++ side (docs/design/sensor-core.md): the ESP-IDF i2c_master bus
// on the sensor pins, the boot probe, and the sensor task that drives the Rust
// hub (sensor_ffi.rs) and persists its calibration record to NVS.
//
// Cost when no sensor answers: one bus create + two 1-byte probes + bus delete
// (~1 ms, no residual heap, no task). With a sensor: a 2.5 KB task stack + the
// i2c_master bus/device objects on the heap (see the design doc's budget).
#pragma once

#include <stddef.h>
#include <stdint.h>

// Compile-time defaults: I2C SDA = GPIO6, SCL = GPIO7 (the Splanc Dev Module's
// I2C0 and the C6's LP_I2C pair, so a low-power path stays possible), INT =
// GPIO21 (the Dev Module's and the PixieLamp's wiring), AD0 = GND (0x68; 0x69
// is probed too). They avoid the strapping pins
// 4/5/8/9/15, USB-JTAG 12/13, the SuperMini's flash 18/19, the LED data pins
// 20/14 and GPIO0/1 (32 kHz crystal on some boards). Overridable per build
// (--copt=-DLM_SENSOR_SDA=…) and at runtime through NVS keys "sens_sda" /
// "sens_scl" / "sens_int" / "sens_en" (read by main.cpp at boot, like hw_gpio0/1).
#ifndef LM_SENSOR_SDA
#define LM_SENSOR_SDA 6
#endif
#ifndef LM_SENSOR_SCL
#define LM_SENSOR_SCL 7
#endif
// MPU-6050 INT (data-ready / FIFO watermark), optional. Recorded and
// collision-checked today; the sensor task polls the FIFO either way (an
// INT-driven wake is the next step, docs/design/sensor-core.md §4.3). -1 = none.
#ifndef LM_SENSOR_INT
#define LM_SENSOR_INT 21
#endif
#ifndef LM_SENSOR_ENABLED
#define LM_SENSOR_ENABLED 1
#endif

// Probe for an IMU on sda/scl and, if one answers, start the sensor task.
// `led_gpio0/1` are the configured LED outputs: a pin conflict disables the
// sensor core instead of fighting the strip. `cal`/`cal_len`: the NVS
// calibration record (may be null). Call once from setup(), after the hardware
// config is loaded.
void sensor_begin(bool enabled, int sda, int scl, int int_gpio, int led_gpio0, int led_gpio1,
                  const uint8_t *cal, size_t cal_len);

// Append the sensor status to the periodic serial report (no-op when absent).
void sensor_log_status();
