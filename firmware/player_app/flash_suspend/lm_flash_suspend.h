// Flash auto-suspend at run time (spi_flash_os_func_app.c here, desk D-459, PR-41): while
// littlefs erases or programs the flash, code keeps running from it (the flash controller
// suspends the erase for each cache miss and resumes it), so a flash write no longer stalls
// the render task. Off until lm_flash_auto_suspend_enable() succeeds.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  LM_FLASH_SUSPEND_ON = 0,
  LM_FLASH_SUSPEND_NO_CHIP = 1,
  LM_FLASH_SUSPEND_OLD_CHIP = 2,
  LM_FLASH_SUSPEND_UNSUPPORTED_FLASH = 3,
  LM_FLASH_SUSPEND_SETUP_FAILED = 4,
};

// Turn auto-suspend on if this chip and flash support it (an ESP32-C6 >= v0.2 with the XMC
// flash of the C6FH4); *chip_id = the flash's JEDEC id. LM_FLASH_SUSPEND_ON, or why not
// (then the stock cache-disabling lock stays).
int lm_flash_auto_suspend_enable(uint32_t *chip_id);
// 1 once enabled.
int lm_flash_auto_suspend_on(void);

#ifdef __cplusplus
}
#endif
