"""`ota_flash`: a `bazel run` launcher that writes the OTA layout (bootloader,
partition table, otadata, loader, app) with esptool — the same launcher shape as
@embedded's esptool_flash (`'0xADDR' "$(rlocation …)"` pairs), so
//tools:flash_bundle can package it unchanged — plus `ota_package`, the signed
over-the-air artifact (manifest ‖ image).
"""

_RUNFILES_INIT = r'''#!/usr/bin/env bash
set -euo pipefail
# --- begin runfiles.bash initialization v3 ---
set -uo pipefail; set +e; f=bazel_tools/tools/bash/runfiles/runfiles.bash
source "${RUNFILES_DIR:-/dev/null}/$f" 2>/dev/null || \
  source "$(grep -sm1 "^$f " "${RUNFILES_MANIFEST_FILE:-/dev/null}" | cut -f2- -d' ')" 2>/dev/null || \
  source "$0.runfiles/$f" 2>/dev/null || \
  { echo>&2 "ERROR: cannot find runfiles.bash"; exit 1; }; f=; set -e
# --- end runfiles.bash initialization v3 ---
'''

def _rloc(ctx, f):
    sp = f.short_path
    if sp.startswith("../"):
        return sp[len("../"):]
    return ctx.workspace_name + "/" + sp

def _ota_flash_impl(ctx):
    images = [
        ("0x0", ctx.file.bootloader),
        ("0x8000", ctx.file.partitions),
        ("0xe000", ctx.file.otadata),
        (ctx.attr.loader_offset, ctx.file.loader),
    ]
    if ctx.file.app:
        images.append((ctx.attr.app_offset, ctx.file.app))

    # esptool lives in @embedded's private @esptool repo; borrow the binary from an
    # esptool_flash target's runfiles (`tool_from`) instead of naming the repo.
    tool_rf = ctx.attr.tool_from[DefaultInfo].default_runfiles
    tools = [f for f in tool_rf.files.to_list() if f.short_path.endswith("/bin/esptool")]
    if not tools:
        fail("no bin/esptool in the runfiles of %s" % ctx.attr.tool_from.label)
    tool = tools[0]
    argv = [
        '"$(rlocation %s)"' % _rloc(ctx, tool),
        '"$@"',
        "'--chip'",
        "'esp32c6'",
        "'write-flash'",
        "'--flash-mode'",
        "'keep'",
        "'--flash-freq'",
        "'keep'",
        "'--flash-size'",
        "'keep'",
    ]
    files = []
    for off, f in images:
        argv.append("'%s'" % off)
        argv.append('"$(rlocation %s)"' % _rloc(ctx, f))
        files.append(f)
    out = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(out, _RUNFILES_INIT + "exec " + " ".join(argv) + "\n", is_executable = True)
    runfiles = ctx.runfiles(files = files).merge(tool_rf)
    runfiles = runfiles.merge(ctx.attr._bash_runfiles[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = out, runfiles = runfiles)]

ota_flash = rule(
    implementation = _ota_flash_impl,
    executable = True,
    doc = "Flash the OTA layout (bootloader + table + otadata + loader [+ app]).",
    attrs = {
        "bootloader": attr.label(default = "@embedded//libs/board:esp32c6_bootloader_bin", allow_single_file = True),
        "partitions": attr.label(mandatory = True, allow_single_file = True),
        # Erased otadata: the bootloader boots the factory LOADER first, which runs the
        # littlefs migration and then selects the app.
        "otadata": attr.label(mandatory = True, allow_single_file = True),
        "loader": attr.label(mandatory = True, allow_single_file = True),
        "loader_offset": attr.string(default = "0x10000"),
        # Optional: a migration's phase-1 bundle leaves the app slot alone.
        "app": attr.label(allow_single_file = True),
        "app_offset": attr.string(default = "0x1c0000"),
        # Any @embedded esptool_flash target: only its esptool is used.
        "tool_from": attr.label(mandatory = True),
        "_bash_runfiles": attr.label(default = "@bazel_tools//tools/bash/runfiles"),
    },
)

def ota_package(name, app, manifest_key, version, key_id = 0, security_version = 0, signer = "//firmware/ota:ota_sign", **kwargs):
    """Builds `<name>.ota`: the signed manifest followed by the app image.

    The 108-byte manifest + image is the one file a client streams over the air (manifest to ota_begin, the rest as
    ota_chunks). Signed at build time with `manifest_key` (a keys/*.key file): only
    the TEST key belongs in a build; release images are signed by the release
    workflow with the OTA_SIGNING_KEY secret (tools/ota_release.sh)."""
    native.genrule(
        name = name,
        srcs = [app, manifest_key],
        outs = [name + ".ota", name + ".manifest"],
        cmd = ("$(execpath %s) sign --key-file $(location %s) --version %s " +
               ("--key-id %d --security-version %d " % (key_id, security_version)) +
               "--in $(location %s) --out $(location %s.manifest) >/dev/null && " +
               "cat $(location %s.manifest) $(location %s) > $(location %s.ota)") % (
            signer,
            manifest_key,
            version,
            app,
            name,
            name,
            app,
            name,
        ),
        tools = [signer],
        **kwargs
    )
