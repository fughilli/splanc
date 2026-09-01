"""A MINIMAL cc toolchain that links a pure-Rust binary statically against musl,
using rust's OWN rust-lld + self-contained musl runtime — no gcc, no glibc, no C.

Scoped (in BUILD) to the `libc:musl` platform, so it binds ONLY the static
player build and never the gnu host/exec tool builds (unlike the global
toolchain_linker_preference flag, which propagates across the exec transition).

rustc still emits the musl crt + libc.a (via -Clink-self-contained=yes on the
player), so this toolchain adds nothing but the linker (rust-lld) + `-static`,
and deliberately omits gcc's default C++/glibc link junk (-lstdc++, -pie, -lc,
-lgcc_s) that turned the earlier gcc-linked build Franken-dynamic.
"""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load(
    "@rules_cc//cc:cc_toolchain_config_lib.bzl",
    "action_config",
    "feature",
    "flag_group",
    "flag_set",
    "tool",
    "tool_path",
)
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

_LINK_ACTIONS = [
    ACTION_NAMES.cpp_link_executable,
    ACTION_NAMES.cpp_link_dynamic_library,
    ACTION_NAMES.cpp_link_nodeps_dynamic_library,
]

def _impl(ctx):
    # The linker is a Bazel File (rust-lld), referenced via action_config tools so
    # the path is resolved portably (works on the linux container AND the macOS
    # deploy host, where the tools repo lays rust-lld out differently).
    link_configs = [
        action_config(
            action_name = name,
            enabled = True,
            tools = [tool(tool = ctx.file.linker)],
        )
        for name in _LINK_ACTIONS
    ]

    static = feature(
        name = "musl_static",
        enabled = True,
        flag_sets = [flag_set(
            actions = _LINK_ACTIONS,
            flag_groups = [flag_group(flags = ["-static"])],
        )],
    )

    # Bazel requires these tool_paths to exist; none but the linker are used (no C
    # is compiled), so point the rest at a harmless no-op.
    tool_paths = [
        tool_path(name = t, path = "/bin/false")
        for t in ("gcc", "ld", "ar", "cpp", "nm", "objdump", "strip")
    ]

    return cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "aarch64-musl-static",
        host_system_name = "local",
        target_system_name = "aarch64-unknown-linux-musl",
        target_cpu = "aarch64",
        target_libc = "musl",
        compiler = "rust-lld",
        abi_version = "unknown",
        abi_libc_version = "unknown",
        action_configs = link_configs,
        features = [static],
        tool_paths = tool_paths,
    )

cc_toolchain_config = rule(
    implementation = _impl,
    attrs = {
        "linker": attr.label(allow_single_file = True, mandatory = True),
    },
    provides = [CcToolchainConfigInfo],
)
