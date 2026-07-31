"""flash_bundle — package an esptool_flash target into one self-describing tar
(flash.json manifest + the .bin images) that a board can be flashed from in a
single step, with no hand-copied offsets.

The offsets/chip/flash-params live in the flash launcher (the source of truth);
this rule harvests the launcher's already-built image files in the *target*
configuration (so it reuses the cached firmware build rather than recompiling it
in the exec config) and hands them to //tools:mk_flashbundle.
"""

def _flash_bundle_impl(ctx):
    flash = ctx.attr.flash[DefaultInfo]
    launcher = flash.files_to_run.executable
    bins = [f for f in flash.default_runfiles.files.to_list() if f.basename.endswith(".bin")]

    out = ctx.actions.declare_file(ctx.label.name + ".tar")
    args = ctx.actions.args()
    args.add("--launcher", launcher)
    args.add("--out", out)
    args.add_all(bins, before_each = "--bin")

    ctx.actions.run(
        executable = ctx.executable._builder,
        inputs = depset([launcher], transitive = [flash.default_runfiles.files]),
        outputs = [out],
        arguments = [args],
        mnemonic = "FlashBundle",
        progress_message = "Packaging flash bundle %{label}",
    )
    return [DefaultInfo(files = depset([out]))]

flash_bundle = rule(
    implementation = _flash_bundle_impl,
    doc = "Self-describing flash bundle (flash.json + bins) from an esptool_flash target.",
    attrs = {
        "flash": attr.label(
            mandatory = True,
            doc = "An esptool_flash target (e.g. //firmware/player_app:flash_esp32c6).",
        ),
        "_builder": attr.label(
            default = "//tools:mk_flashbundle",
            executable = True,
            cfg = "exec",
        ),
    },
)
