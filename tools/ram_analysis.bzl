"""Static-RAM analysis of a firmware ELF, as build targets.

`ram_analysis(name, image)` wraps //tools:fw_memaudit + //tools:fw_memviz so a
firmware image's static-RAM breakdown is a normal build artifact. It creates:

  <name>.ram.json    — machine-readable audit  (fw_memaudit --json over `image`)
  <name>.ram_report  — treeview + SRAM budget   (fw_memviz over the json)
  <name>             — a filegroup bundling both

Everything is tagged `manual`: `image` is a heavy from-source firmware build, so
these build only when asked. Example (see firmware/player_app/BUILD.bazel):

  bazel build //firmware/player_app:esp32c6_ram
  cat bazel-bin/firmware/player_app/esp32c6_ram.ram_report
  # or just the JSON, to pipe elsewhere:
  bazel build //firmware/player_app:esp32c6_ram.ram.json

The binutils (readelf/nm/addr2line) come from fw_memaudit's own Nix-vendored
runfiles, so no host toolchain is needed.
"""

def ram_analysis(name, image, depth = 3, top = 40, min_bytes = 256, tags = []):
    """Create <name>.ram.json, <name>.ram_report and a <name> filegroup.

    Args:
      name: base name; the outputs are <name>.ram.json / <name>.ram_report.
      image: a firmware_binary label (e.g. //firmware/player_app:esp32c6). Its
        DefaultInfo is the flashable .bin; the ELF is pulled from its `elf`
        output group (see @embedded//rules:firmware.bzl).
      depth: treeview depth in the report (1=component, 2=+file, 3=+symbol).
      top: how many biggest symbols to list in the report.
      min_bytes: hide tree nodes below this many bytes in the report.
      tags: extra tags; `manual` is always added.
    """
    manual = tags + ["manual"]

    # firmware_binary's DefaultInfo is the .bin; grab the ELF from its `elf`
    # output group so --elf gets a real, singular Bazel artifact.
    elf = "_%s_elf" % name
    native.filegroup(
        name = elf,
        srcs = [image],
        output_group = "elf",
        tags = manual,
    )

    native.genrule(
        name = "_%s_ram_json" % name,
        srcs = [":" + elf],
        outs = ["%s.ram.json" % name],
        tools = ["//tools:fw_memaudit"],
        cmd = "$(execpath //tools:fw_memaudit) --json --elf $(execpath :%s) > $@" % elf,
        tags = manual,
    )

    native.genrule(
        name = "_%s_ram_report" % name,
        srcs = ["%s.ram.json" % name],
        outs = ["%s.ram_report" % name],
        tools = ["//tools:fw_memviz"],
        cmd = "$(execpath //tools:fw_memviz) $(execpath %s.ram.json) --depth %d --top %d --min %d > $@" % (
            name,
            depth,
            top,
            min_bytes,
        ),
        tags = manual,
    )

    native.filegroup(
        name = name,
        srcs = ["%s.ram.json" % name, "%s.ram_report" % name],
        tags = manual,
    )
