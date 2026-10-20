"""Hermetic Kani (https://github.com/model-checking/kani) for Bazel.

`cargo kani setup` assembles ~/.kani/kani-<ver>/ from two pieces:
- Kani's prebuilt release bundle. It holds kani-driver, kani-compiler, CBMC,
  goto-cc and goto-instrument, plus a sysroot whose core/std/kani rlibs are
  already built for Kani.
- A `toolchain/` link to the pinned nightly rustc. kani-compiler loads that
  toolchain's librustc_driver and libLLVM through its
  `$ORIGIN/../toolchain/lib` rpath.

This repository rule does the same assembly from two pinned downloads, with no
rustup, no ~/.kani and no network at test time:

  kani_bundle(name = "kani")   # via use_repo_rule in MODULE.bazel

It exposes `@kani//:bundle` (every file) and `@kani//:kani_driver`.
"""

_VERSION = "0.68.0"

# The nightly kani-compiler is linked against (the bundle's
# rust-toolchain-version): rustc 1.100.0-nightly (8925ea358 2026-08-20).
_NIGHTLY_DATE = "2026-08-21"

# sha256 from the release asset digests / static.rust-lang.org .sha256 files.
_PLATFORMS = {
    "aarch64-unknown-linux-gnu": struct(
        kani = "0042d2688bf1550270def4a79c96aaeea138631818cb4ab5480120f2d51a942c",
        rustc = "1752c051596e4d63575f3c50939f76b680bebb412c249593d0f3231ea962bee4",
    ),
    "x86_64-unknown-linux-gnu": struct(
        kani = "32e2b484d73ede0bbf64a2cf0879c4259422497d8aec4ee67d448de9ae7843d3",
        rustc = "e531815fa551362b5a485e0d286b6c96555312d49359c0b8fe9e8f34c45594b4",
    ),
    "aarch64-apple-darwin": struct(
        kani = "a5d39a5d5e748253a553aa62f295c6c397287927a28e5e32691d7ff2eda0c398",
        rustc = "d9096c50eb2d844cc302398aa654e9d55a7a047d18e4e9d156a5276c3ff35fad",
    ),
    "x86_64-apple-darwin": struct(
        kani = "b1367f694c1350abcae133701f78b3be3fd6e9beb66681a22ea0bcac0cc34808",
        rustc = "bfa3e16772558a5ac2c0ff2c13578c25b235a90a7e07270f1c9a6951faceee08",
    ),
}

def _host_triple(rctx):
    os = rctx.os.name.lower()
    arch = rctx.os.arch.lower()
    cpu = "aarch64" if arch in ("aarch64", "arm64") else "x86_64"
    if os.startswith("mac"):
        return cpu + "-apple-darwin"
    if os.startswith("linux"):
        return cpu + "-unknown-linux-gnu"
    fail("kani_bundle: no Kani release for host os %r" % os)

_BUILD = """\
package(default_visibility = ["//visibility:public"])

filegroup(
    name = "bundle",
    srcs = glob(["**"], exclude = ["BUILD.bazel", "WORKSPACE"]),
)

exports_files([
    "bin/kani-compiler",
    "bin/kani-driver",
])

alias(
    name = "kani_driver",
    actual = "bin/kani-driver",
)
"""

def _kani_bundle_impl(rctx):
    triple = _host_triple(rctx)
    sums = _PLATFORMS[triple]
    rctx.download_and_extract(
        url = "https://github.com/model-checking/kani/releases/download/kani-{v}/kani-{v}-{t}.tar.gz".format(
            v = _VERSION,
            t = triple,
        ),
        sha256 = sums.kani,
        stripPrefix = "kani-" + _VERSION,
    )

    # Only the `rustc` component is needed. Its lib/ holds the librustc_driver
    # and libLLVM that kani-compiler is a driver for; the sysroot it compiles
    # against is the bundle's own lib/rustlib.
    rctx.download_and_extract(
        url = "https://static.rust-lang.org/dist/{d}/rustc-nightly-{t}.tar.xz".format(
            d = _NIGHTLY_DATE,
            t = triple,
        ),
        sha256 = sums.rustc,
        output = "toolchain",
        stripPrefix = "rustc-nightly-{t}/rustc".format(t = triple),
    )
    rctx.file("BUILD.bazel", _BUILD)

kani_bundle = repository_rule(
    implementation = _kani_bundle_impl,
    doc = "Kani's release bundle + its pinned nightly rustc libs, assembled like `cargo kani setup`.",
)
