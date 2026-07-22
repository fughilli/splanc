"""Compilation-mode transition: always build a dep subgraph with -c opt.

The solver deployments (native subprocess binary in the server's runfiles,
wasm bundle served at /solver/) are ~10x slower unoptimized, and nobody
runs `bazelisk run //web:serve` with -c opt in the dev loop — so the
deployment targets pin themselves to opt via this transition instead of
trusting the invocation. Both solver sides transition identically, so the
placement benchmark (welcome.solverBenchMs vs the phone's wasm score)
always compares opt against opt.

Unit tests keep the invocation's mode (fast dev iteration); only the
wrapped DEPLOYMENT targets pay the opt build.
"""

def _opt_transition_impl(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt"}

_opt_transition = transition(
    implementation = _opt_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:compilation_mode"],
)

def _opt_binary_impl(ctx):
    info = ctx.attr.binary[0][DefaultInfo]
    out = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(
        output = out,
        target_file = info.files_to_run.executable,
        is_executable = True,
    )
    return [DefaultInfo(
        executable = out,
        files = depset([out]),
        runfiles = ctx.runfiles(files = [out]).merge(info.default_runfiles),
    )]

opt_binary = rule(
    implementation = _opt_binary_impl,
    doc = "An executable dep rebuilt with -c opt regardless of the " +
          "invocation's compilation mode.",
    attrs = {
        "binary": attr.label(
            cfg = _opt_transition,
            executable = True,
            mandatory = True,
        ),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
    executable = True,
)

def _opt_files_impl(ctx):
    return [DefaultInfo(
        files = depset(transitive = [t[DefaultInfo].files for t in ctx.attr.srcs]),
        runfiles = ctx.runfiles().merge_all(
            [t[DefaultInfo].default_runfiles for t in ctx.attr.srcs],
        ),
    )]

opt_files = rule(
    implementation = _opt_files_impl,
    doc = "Forward deps' default outputs, rebuilt with -c opt regardless " +
          "of the invocation's compilation mode.",
    attrs = {
        "srcs": attr.label_list(
            cfg = _opt_transition,
            mandatory = True,
        ),
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
    },
)
