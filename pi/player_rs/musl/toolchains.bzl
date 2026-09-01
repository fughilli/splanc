"""One (rust + cc) toolchain pair per EXEC host for the static-musl player build.

The linker (rust-lld) and rustc are exec-host binaries, so each exec host needs
its own rust tools repo: the linux container builds with the linux repo, the
macOS deploy host with the macos repo (aarch64 or x86_64). All pairs target the
SAME `libc:musl` aarch64-linux platform, so only the static player build binds
them — never the gnu host/exec tool builds. Repos are fetched lazily, so a given
host only pulls the tools it actually uses.
"""

load("@rules_cc//cc:defs.bzl", "cc_toolchain")
load(":cc_toolchain_config.bzl", "cc_toolchain_config")

def musl_toolchains(name, exec_compatible_with, tools):
    """rust + cc musl toolchains for one exec host.

    Args:
      name: unique prefix (e.g. "linux", "macos_arm64").
      exec_compatible_with: exec-host constraints (cpu + os).
      tools: the rust tools repo for that exec host (a @repo label, no //).
    """
    target_compatible_with = [
        "@platforms//cpu:aarch64",
        "@platforms//os:linux",
        ":musl",
    ]

    cc_toolchain_config(
        name = name + "_cc_config",
        linker = tools + "//:rust-lld",
    )
    lld = tools + "//:rust-lld"
    cc_toolchain(
        name = name + "_cc",
        all_files = lld,
        ar_files = lld,
        compiler_files = lld,
        dwp_files = lld,
        linker_files = lld,
        objcopy_files = lld,
        strip_files = lld,
        toolchain_config = ":" + name + "_cc_config",
    )
    native.toolchain(
        name = name + "_cc_toolchain",
        exec_compatible_with = exec_compatible_with,
        target_compatible_with = target_compatible_with,
        toolchain = ":" + name + "_cc",
        toolchain_type = "@bazel_tools//tools/cpp:toolchain_type",
    )
    native.toolchain(
        name = name + "_rust_toolchain",
        exec_compatible_with = exec_compatible_with,
        target_compatible_with = target_compatible_with,
        target_settings = ["@rules_rust//rust/toolchain/channel:stable"],
        toolchain = tools + "//:rust_toolchain",
        toolchain_type = "@rules_rust//rust:toolchain",
    )
