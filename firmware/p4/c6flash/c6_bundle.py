"""Pack the C6 images into one blob the P4 image carries (docs/design/p4-c6-split.md §5.1).

    c6_bundle.py out.bin 0x0=bootloader.bin 0x8000=partitions.bin 0xe000=boot_app0.bin 0x10000=app.bin

Layout (little-endian), read by c6_flasher.cpp:
    "C6B1"                      magic
    u32 count
    u8[32] app_elf_sha256       from the app image's esp_app_desc_t (the app is the image at 0x10000)
    count x { u32 offset, u32 size, u32 zsize, u8[16] md5 }   md5 of the uncompressed image
    the images, zlib-compressed (what the flasher stub's FLASH_DEFL_* takes), in order
"""

import hashlib
import struct
import sys
import zlib

APP_OFFSET = 0x10000
# esp_image_header_t (24 B) + the first segment header (8 B), then esp_app_desc_t:
# magic u32, secure_version u32, reserv1 u32[2], version[32], project_name[32], time[16],
# date[16], idf_ver[32], app_elf_sha256[32].
APP_DESC_AT = 24 + 8
ELF_SHA_AT = APP_DESC_AT + 4 + 4 + 8 + 32 + 32 + 16 + 16 + 32
APP_DESC_MAGIC = 0xABCD5432


def main() -> None:
    out = sys.argv[1]
    images = []
    for arg in sys.argv[2:]:
        off, path = arg.split("=", 1)
        data = open(path, "rb").read()
        if len(data) % 4:
            data += b"\xff" * (4 - len(data) % 4)
        images.append((int(off, 0), data))
    apps = [d for o, d in images if o == APP_OFFSET]
    if len(apps) != 1:
        raise SystemExit("need exactly one image at the app offset 0x10000")
    app = apps[0]
    (magic,) = struct.unpack_from("<I", app, APP_DESC_AT)
    if magic != APP_DESC_MAGIC:
        raise SystemExit(f"no esp_app_desc_t in the app image (magic 0x{magic:08x})")
    elf_sha = app[ELF_SHA_AT : ELF_SHA_AT + 32]
    head = b"C6B1" + struct.pack("<I", len(images)) + elf_sha
    body = b""
    for off, data in images:
        z = zlib.compress(data, 9)
        head += struct.pack("<III", off, len(data), len(z)) + hashlib.md5(data).digest()
        body += z
    with open(out, "wb") as f:
        f.write(head + body)
    total = sum(len(d) for _, d in images)
    print(
        f"c6 bundle: {len(images)} images, {total} B -> {len(head) + len(body)} B, app elf sha {elf_sha.hex()[:16]}"
    )


if __name__ == "__main__":
    main()
