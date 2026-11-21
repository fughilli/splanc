"""Attribute a firmware ELF's flash to source components through DWARF line info.

usage: attribute_flash.py <nm -S -l --size-sort output>

Produce the input with the ESP toolchain, e.g.
  riscv32-esp-elf-nm -S -l --size-sort player_app_netstack > syms.txt
Symbols without line info (the vendor blobs and our Rust, which is built without
DWARF) land in "nodebug". Used for docs/design/matter-on-c6.md §2.2.
"""

import collections
import sys


def component(path: str) -> str:
    if not path:
        return "nodebug (vendor blobs + Rust)"
    if "lwip" in path:
        return "lwip (+ esp_netif)"
    for key in ("mbedtls", "wpa_supplicant", "espcoredump", "network_provisioning"):
        if key in path:
            return key
    if "arduino_esp32/libraries/" in path:
        return "arduino:" + path.split("libraries/")[1].split("/")[0]
    if "arduino_esp32/cores" in path:
        return "arduino:core"
    if "/firmware/" in path:
        return "ours C++ (" + path.split("/firmware/")[1].split("/")[0] + ")"
    if "components/" in path:
        return "idf:" + path.split("components/")[1].split("/")[0]
    return "other"


def main() -> None:
    tot: collections.Counter = collections.Counter()
    for line in open(sys.argv[1], errors="replace"):
        parts = line.rstrip("\n").split("\t")
        head = parts[0].split(None, 3)
        if len(head) < 4:
            continue
        addr, size, typ = int(head[0], 16), int(head[1], 16), head[2]
        in_flash = 0x42000000 <= addr < 0x44000000
        in_iram_text = 0x40800000 <= addr < 0x40880000 and typ in "tTwW"
        if not (in_flash or in_iram_text):
            continue
        tot[component(parts[1] if len(parts) > 1 else "")] += size
    for name, size in tot.most_common(40):
        print("%-40s %9d" % (name, size))
    print("%-40s %9d" % ("total", sum(tot.values())))


if __name__ == "__main__":
    main()
