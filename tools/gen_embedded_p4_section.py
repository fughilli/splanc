"""Emit the esp32p4 section of @embedded's nix/arduino_esp32.BUILD from the
esp32-arduino-libs esp32p4 flags/ response files (includes, defines, c/cpp flags).

    python3 tools/gen_embedded_p4_section.py <esp32-arduino-libs>/esp32p4 > section.BUILD

The output is the esp32p4 section of @embedded's nix/arduino_esp32.BUILD
(embedded commit 3242aa3); regenerate it there when the libs pin moves.
"""

import os
import shlex
import sys

d = sys.argv[1]


def tokens(name):
    with open(os.path.join(d, "flags", name)) as f:
        return shlex.split(f.read())


inc = []
t = tokens("includes")
for i, x in enumerate(t):
    if x == "-iwithprefixbefore":
        inc.append("sdk/esp32p4/include/" + t[i + 1])
defines = [x[2:] for x in tokens("defines") if x.startswith("-D")]


def q(s):
    # Bazel string literal. A define carrying quotes (X="v") is emitted like the C3
    # section's ARDUINO_BOARD: single-quoted, with \\" so the compiler sees \".
    if '"' in s:
        return "'" + s.replace('"', '\\\\"') + "'"
    return '"' + s + '"'


def flags(name, extra):
    out = [x for x in tokens(name) if not x.startswith("-mabi") and not x.startswith("-march")]
    return ["-march=rv32imafc_zicsr_zifencei_xesploop_xespv", "-mabi=ilp32f"] + out + extra


C = flags("c_flags", ["-DCHIP_HAVE_CONFIG_H", "-Wno-strict-prototypes", "-w"])
CXX = flags("cpp_flags", ["-DCHIP_HAVE_CONFIG_H", "-w"])


def lst(xs, ind=8):
    return "\n".join(" " * ind + q(x) + "," for x in xs)


print('''
# --- esp32p4 (RISC-V rv32imafc + Xesppie, hard-float ilp32f) -----------------
# GENERATED from esp32-arduino-libs esp32p4/flags/{includes,defines,c_flags,
# cpp_flags} by splanc tools/gen_embedded_p4_section.py; regenerate, don't edit.
# Die v3.1+ libs (CONFIG_ESP32P4_REV_MIN_301); a v1.x board needs esp32p4_es.
# mbedTLS comes from the PREBUILT libs here (the P4 player terminates no TLS;
# the C6 front end does), so no from-source mbedtls and no ssl wraps.

genrule(
    name = "sdk_link_dirs_esp32p4",
    srcs = [
        "sdk/esp32p4/lib/libriscv.a",
        "sdk/esp32p4/ld/memory.ld",
        "sdk/esp32p4/qio_qspi/libspi_flash.a",
    ],
    outs = ["sdk_link_dirs_esp32p4.rsp"],
    cmd = ("echo \\"-L$$(dirname $(location sdk/esp32p4/lib/libriscv.a))\\" > $@ && " +
           "echo \\"-L$$(dirname $(location sdk/esp32p4/ld/memory.ld))\\" >> $@ && " +
           "echo \\"-L$$(dirname $(location sdk/esp32p4/qio_qspi/libspi_flash.a))\\" >> $@"),
)

filegroup(name = "sdk_libs_esp32p4", srcs = glob([
    "sdk/esp32p4/lib/*.a",
    "sdk/esp32p4/qio_qspi/*.a",
    "sdk/esp32p4/ld/*.a",
]))
filegroup(name = "sdk_ld_esp32p4", srcs = glob(["sdk/esp32p4/ld/*.ld"]))
filegroup(name = "ld_flags_esp32p4", srcs = ["sdk/esp32p4/flags/ld_flags"])
filegroup(name = "ld_scripts_esp32p4", srcs = ["sdk/esp32p4/flags/ld_scripts"])
filegroup(name = "ld_libs_esp32p4", srcs = ["sdk/esp32p4/flags/ld_libs"])
filegroup(name = "bootloader_elf_esp32p4", srcs = ["sdk/esp32p4/bin/bootloader_qio_80m.elf"])

cc_library(
    name = "sdk_hdrs_esp32p4",
    hdrs = glob(
        ["sdk/esp32p4/include/**/*.h", "sdk/esp32p4/qio_qspi/include/**/*.h",
         "cores/esp32/**/*.h", "variants/esp32p4/**/*.h", "sdk/esp32p4/include/**/*.hpp",
         "libraries/SPI/**/*.h"],
        allow_empty = True,
    ),
    includes = [
%s
        "sdk/esp32p4/qio_qspi/include",
        "cores/esp32",
        "variants/esp32p4",
        "libraries/SPI/src",  # FastLED's ESP32 SPI shim includes <SPI.h>
    ],
    defines = [
%s
        "F_CPU=400000000L",
        "ARDUINO=10812",
        "ARDUINO_ESP32P4_DEV",
        "ARDUINO_ARCH_ESP32",
        "ARDUINO_PARTITION_default",
        'ARDUINO_BOARD=\\\\"ESP32P4_DEV\\\\"',
        'ARDUINO_VARIANT=\\\\"esp32p4\\\\"',
        "ESP32=ESP32",
        "CORE_DEBUG_LEVEL=0",
        # Serial = the USB-Serial-JTAG port (HWCDC); the HS OTG port stays free
        # for the USB host (a Vive tracker on the splanc P4 player).
        "ARDUINO_USB_MODE=1",
        "ARDUINO_USB_CDC_ON_BOOT=1",
        # boards.txt esp32p4 build.extra_flags: initArduino() brings PSRAM up
        # (psramInit) only with this defined.
        "BOARD_HAS_PSRAM",
    ],
)

_C_COPTS_ESP32P4 = [
%s
]

_CXX_COPTS_ESP32P4 = [
%s
]

cc_library(
    name = "core_c_esp32p4",
    srcs = glob(["cores/esp32/**/*.c", "variants/esp32p4/**/*.c"], allow_empty = True),
    copts = _C_COPTS_ESP32P4,
    alwayslink = True,
    deps = [":sdk_hdrs_esp32p4"],
)

cc_library(
    name = "core_cpp_esp32p4",
    srcs = glob(["cores/esp32/**/*.cpp", "variants/esp32p4/**/*.cpp", "libraries/SPI/**/*.cpp"], allow_empty = True),
    copts = _CXX_COPTS_ESP32P4,
    alwayslink = True,
    deps = [":sdk_hdrs_esp32p4"],
)

cc_library(
    name = "core_esp32p4",
    additional_linker_inputs = [
        ":sdk_link_dirs_esp32p4", ":sdk_libs_esp32p4", ":sdk_ld_esp32p4",
        ":ld_flags_esp32p4", ":ld_scripts_esp32p4", ":ld_libs_esp32p4",
    ],
    linkopts = [
        "@$(location :sdk_link_dirs_esp32p4)",
        "@$(location :ld_flags_esp32p4)",
        "@$(location :ld_scripts_esp32p4)",
        "-Wl,--wrap=esp_panic_handler",
        "-Wl,--start-group",
        "@$(location :ld_libs_esp32p4)",
        "-Wl,--end-group",
        "-Wl,-EL",
    ],
    deps = [":core_c_esp32p4", ":core_cpp_esp32p4", ":sdk_hdrs_esp32p4"],
)

cc_library(
    name = "preferences_esp32p4",
    srcs = glob(["libraries/Preferences/src/**/*.cpp"], allow_empty = True),
    hdrs = glob(["libraries/Preferences/src/**/*.h"], allow_empty = True),
    copts = _CXX_COPTS_ESP32P4,
    includes = ["libraries/Preferences/src"],
    deps = [":sdk_hdrs_esp32p4"],
)
''' % (lst(inc), lst(defines), lst(C, 4), lst(CXX, 4)))
