"""Build a Rust cdylib for wasm32-unknown-unknown, always optimized.

`rust_wasm_bindgen` does this transition internally for wasm-bindgen crates;
this is the same transition for a crate with a plain `extern "C"` ABI that
needs no JS glue (//firmware/pattern:kernel_wasm). The single .wasm the target
produces is forwarded as `<name>.wasm`.
"""

def _wasm32_opt_transition_impl(_settings, _attr):
    return {
        "//command_line_option:compilation_mode": "opt",
        "//command_line_option:platforms": str(Label("@rules_rust//rust/platform:wasm32")),
        # Whole-program LTO: the module is embedded in the app bundle, so size
        # matters more than build time (the crate graph is two tiny crates).
        str(Label("@rules_rust//rust/settings:lto")): "fat",
    }

_wasm32_opt_transition = transition(
    implementation = _wasm32_opt_transition_impl,
    inputs = [],
    outputs = [
        "//command_line_option:compilation_mode",
        "//command_line_option:platforms",
        str(Label("@rules_rust//rust/settings:lto")),
    ],
)

def _wasm32_cdylib_impl(ctx):
    wasm = [f for f in ctx.attr.lib[0][DefaultInfo].files.to_list() if f.extension == "wasm"]
    if len(wasm) != 1:
        fail("{} must produce exactly one .wasm, got {}".format(ctx.attr.lib[0].label, wasm))
    out = ctx.actions.declare_file(ctx.label.name + ".wasm")
    ctx.actions.symlink(output = out, target_file = wasm[0])
    return [DefaultInfo(files = depset([out]))]

wasm32_cdylib = rule(
    implementation = _wasm32_cdylib_impl,
    doc = "A rust_shared_library rebuilt for wasm32-unknown-unknown with -c opt.",
    attrs = {
        "lib": attr.label(cfg = _wasm32_opt_transition, mandatory = True),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
