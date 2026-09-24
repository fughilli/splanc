// Mini has no battery/source-selector control pins.
// Splanc Mini — USB-PD-only board pin map for the ESP32-C6.
//
// This is the firmware side of the PCB designed in //hardware/splanc_dev and
// specified in hardware/splanc_dev/mini.md. Selected by building the
// player app with -DLM_BOARD_SPLANC_MINI (the //firmware/player_app:splanc_mini
// target); the default DevKit wiring in led_config.h is unchanged otherwise.
//
// The chip is a stock ESP32-C6 (board = esp32c6), so no new @embedded platform
// is needed — only this pin configuration and the driver rollup in the BUILD
// target. Pins match the ESP32-C6-WROOM-1 module's exposed GPIO subset (IO14/16/
// 17 are not broken out as GPIO on the module: 16/17 are UART0).
#pragma once
#define SPLANC_HARDWARE_REVISION 3
#define SPLANC_STATUS_LED_PIN 10  // active LOW
#define SPLANC_HAS_BATTERY 0

// -- LED output channels (RMT WS2812, level-shifted to 5 V) ------------------
#define LED_DATA_PIN 0    // Channel 0 data  -> 74LVC1T45 -> CH0 connector
#define LED_DATA_PIN_2 1  // Channel 1 data  -> 74LVC1T45 -> CH1 connector

// -- Per-channel load switch (enable out, fault in) --------------------------
#define SPLANC_LOAD_SW0_EN_PIN 2
#define SPLANC_LOAD_SW0_FLT_PIN 3
#define SPLANC_LOAD_SW1_EN_PIN 4
#define SPLANC_LOAD_SW1_FLT_PIN 5

// -- Shared I2C0 bus (sensors, PD controller, 2x INA226) ---------------------
#define SPLANC_I2C_SDA_PIN 6
#define SPLANC_I2C_SCL_PIN 7

// -- I2S0 microphone (T5848, translated to 1.8V) ----------------------------------------------
#define SPLANC_I2S_BCLK_PIN 18
#define SPLANC_I2S_WS_PIN 19
#define SPLANC_I2S_DIN_PIN 20  // NB: shares the GPIO number with a devkit LED pin

// -- Sensor interrupt (ICM-42670-P INT1) -----------------------------------
#define SPLANC_IMU_INT_PIN 21

// -- User + system buttons ---------------------------------------------------
#define SPLANC_USER_BTN1_PIN 22
#define SPLANC_USER_BTN2_PIN 23
#define SPLANC_BOOT_PIN 9  // BOOT strap / download button

// -- I2C device addresses (7-bit) --------------------------------------------
#define SPLANC_I2C_ADDR_MMC5603NJ 0x30  // compass, populated
#define SPLANC_I2C_ADDR_TPS25730 0x20  // USB PD contract/status
#define SPLANC_I2C_ADDR_INA226_CH0 0x40
#define SPLANC_I2C_ADDR_INA226_CH1 0x41
#define SPLANC_I2C_ADDR_ICM42670 0x68
#define SPLANC_I2C_ADDR_BMP580 0x46
