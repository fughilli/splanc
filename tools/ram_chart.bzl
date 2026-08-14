"""`ram_chart`: a `.ram_chart` sibling target for a `firmware_binary`.

`firmware_binary` (from `@embedded//rules:firmware.bzl`) exposes the retargeted
ELF via its `elf` output group. This macro wraps that ELF in a runnable static
RAM auditor (`//tools:fw_memaudit`), so every image gets an inspection subtarget
next to it:

    firmware_binary(name = "esp32c6", binary = ":player_app", board = "esp32c6")
    ram_chart(name = "esp32c6.ram_chart", binary = ":esp32c6")

    bazel run //firmware/player_app:esp32c6.ram_chart              # build + chart
    bazel run //firmware/player_app:esp32c6.ram_chart -- --json    # snapshot
    bazel run //firmware/player_app:esp32c6.ram_chart -- \
        --compare /tmp/before.json                                 # track a cut

It is a `bazel run` target (like the `esptool_flash` / `flash_bundle` siblings)
rather than a build action: the auditor shells out to the host `nm`/`readelf`,
which read the cross ELF fine but aren't hermetic Bazel inputs. `tags=["manual"]`
keeps it (and the `-c opt` firmware build it pulls in) out of `//...` wildcards.

The auditor lives in `@embedded` upstream would be the natural home, but it is
carried here so it can iterate with the protocol/FFI it measures; see
`docs/design/ram-budget.md`.
"""

load("@rules_python//python:defs.bzl", "py_binary")

def ram_chart(name, binary, **kwargs):
    """Runnable static-RAM auditor for `binary`'s ELF output group.

    Args:
      name: target name — conventionally `<firmware_binary>.ram_chart`.
      binary: the `firmware_binary` label to inspect (its `elf` output group).
      **kwargs: forwarded to the `py_binary` (e.g. `visibility`).
    """
    elf = name + "_elf"

    # Pull the retargeted ELF out of the firmware_binary's `elf` output group;
    # DefaultInfo is the packaged .bin, which the auditor can't read.
    native.filegroup(
        name = elf,
        srcs = [binary],
        output_group = "elf",
        tags = ["manual"],
    )

    py_binary(
        name = name,
        srcs = ["//tools:fw_memaudit.py"],
        main = "fw_memaudit.py",
        data = [":" + elf],
        # Default to the wrapped ELF; anything after `--` on the command line
        # (e.g. `--json`, `--compare x.json`, `--top 50`) is appended and wins.
        args = ["--elf", "$(rootpath :%s)" % elf],
        tags = ["manual"],
        **kwargs
    )
