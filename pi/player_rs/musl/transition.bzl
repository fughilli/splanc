"""Build a target under the musl platform, scoped so ONLY this subgraph is
affected. The `libc:musl`-constrained rust + cc toolchains (see BUILD) do the
rest — rust-lld + self-contained musl, static — without disturbing gnu host/exec
builds. Just a platform transition; no global flags that would leak to exec.
"""

def _impl(_settings, attr):
    return {
        "//command_line_option:platforms": [str(attr.target_platform)],
    }

_static_musl_transition = transition(
    implementation = _impl,
    inputs = [],
    outputs = [
        "//command_line_option:platforms",
    ],
)

def _binary_impl(ctx):
    src = ctx.attr.src[0][DefaultInfo].files.to_list()[0]

    # Name the output "player" (not the target name) so build_data keys it as
    # "player" for apps.nix.
    out = ctx.actions.declare_file("player")
    ctx.actions.symlink(output = out, target_file = src, is_executable = True)
    return [DefaultInfo(files = depset([out]), executable = out)]

static_musl_binary = rule(
    implementation = _binary_impl,
    executable = True,
    attrs = {
        "src": attr.label(cfg = _static_musl_transition, mandatory = True),
        "target_platform": attr.label(mandatory = True),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
