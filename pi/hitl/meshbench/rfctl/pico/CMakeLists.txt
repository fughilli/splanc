# rfctl firmware for the Raspberry Pi Pico 2 (RP2350A), built with pico-sdk >= 2.1.
#
#   nix shell nixpkgs#cmake nixpkgs#gcc-arm-embedded nixpkgs#python3 nixpkgs#picotool
#   git clone --depth 1 -b 2.1.1 https://github.com/raspberrypi/pico-sdk
#   git -C pico-sdk submodule update --init --depth 1 lib/tinyusb
#   cmake -S pi/hitl/meshbench/rfctl/pico -B /tmp/rfctl-build \
#         -DPICO_SDK_PATH=$PWD/pico-sdk -DPICO_BOARD=pico2
#   cmake --build /tmp/rfctl-build -j    # -> /tmp/rfctl-build/rfctl.uf2
#
# Flash: hold BOOTSEL while plugging in (or send `bootsel` to a running rfctl), then
# copy rfctl.uf2 to the RP2350 drive, or `picotool load -x rfctl.uf2`.
# Or run pi/hitl/meshbench/rfctl/pico/build.sh, which does all of the above.
cmake_minimum_required(VERSION 3.13)
set(PICO_BOARD pico2 CACHE STRING "Board type")
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake OPTIONAL RESULT_VARIABLE _found)
if(NOT _found)
  include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)
endif()
project(rfctl C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

get_filename_component(RFCTL_DIR ${CMAKE_CURRENT_LIST_DIR}/.. ABSOLUTE)
add_executable(rfctl
  main.c
  ${RFCTL_DIR}/rfctl_core.c
  ${RFCTL_DIR}/board_default.c
)
target_include_directories(rfctl PRIVATE ${RFCTL_DIR})
target_compile_options(rfctl PRIVATE -Wall -Wextra -Werror -Wno-unused-parameter)
target_compile_definitions(rfctl PRIVATE
  USBD_MANUFACTURER="splanc"
  USBD_PRODUCT="rfctl mesh-bench"
  PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS=0
  PICO_STDIO_DEFAULT_CRLF=0
)
target_link_libraries(rfctl pico_stdlib hardware_spi hardware_timer hardware_watchdog hardware_sync)
pico_enable_stdio_usb(rfctl 1)
pico_enable_stdio_uart(rfctl 0)
pico_add_extra_outputs(rfctl)
