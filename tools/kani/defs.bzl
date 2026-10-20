"""`rust_kani_test`: run a rust_library's Kani proofs (#[kani::proof]) as a Bazel test.

    rust_kani_test(
        name = "region_kani",
        crate = ":region",
        harnesses = ["pool_bookkeeping"],  # default: every harness
    )

How it maps onto Kani (see docs/design/kani-bazel.md):
- **The crate under test** runs through Kani's standalone mode
  (`kani-driver <crate root>`), which does the whole pipeline: kani-compiler, a
  rustc driver, emits a goto program per harness, then goto-cc,
  goto-instrument and CBMC verify it. Standalone mode forwards RUSTFLAGS to
  kani-compiler, which carries the edition and the deps' --extern / -L flags.
  It writes its goto artifacts next to the root file, so the test stages the
  sources into $TEST_TMPDIR first.
- **Deps** are rebuilt by an aspect with kani-compiler, exactly as `cargo kani`
  does: the same Kani flags (Kani's sysroot and std, `-Z always-encode-mir`),
  `--emit=metadata` only. Codegen of whatever a harness reaches in a dep
  happens in the top crate, from the MIR those rmetas carry.

Not handled: proc-macro deps and build scripts. Those would have to run inside
kani-compiler's nightly rustc, and the bundle ships only its libs.
"""

load("@rules_rust//rust:rust_common.bzl", "CrateInfo")

# The flags `cargo kani` gives every crate it builds (kani-driver's
# call_cargo.rs / the kani-compiler command lines it logs under --verbose),
# with the bundle root substituted for ~/.kani/kani-<ver>.
_KANI_FLAGS = [
    "-C",
    "overflow-checks=on",
    "-Z",
    "unstable-options",
    "-Z",
    "trim-diagnostic-paths=no",
    "-Z",
    "human_readable_cgu_names",
    "-Z",
    "always-encode-mir",
    "--cfg=kani",
    "-Z",
    "crate-attr=feature(register_tool)",
    "-Z",
    "crate-attr=register_tool(kanitool)",
    "--force-warn",
    "unstable_features",
    "--sysroot",
    "{bundle}",
    "-L",
    "{bundle}/lib",
    "--extern",
    "force:kani",
    "--extern",
    "noprelude,nounused:std={bundle}/lib/libstd.rlib",
    "-C",
    "panic=abort",
    "-C",
    "symbol-mangling-version=v0",
    "-Z",
    "panic_abort_tests=yes",
    "-Z",
    "mir-enable-passes=-RemoveStorageMarkers",
    "--check-cfg=cfg(kani)",
    "-Clinker=echo",
    "--kani-compiler",
]

KaniCrateInfo = provider(
    doc = "A crate rebuilt by kani-compiler (metadata only), for --extern into a Kani run.",
    fields = {
        "crate_name": "The crate's name (its --extern key).",
        "rmeta": "File: the Kani-built .rmeta.",
        "dep_externs": "list of struct(name, rmeta): this crate's direct deps.",
        "dep_rmetas": "depset of File: every transitive dep's .rmeta (not this crate's).",
    },
)

def _bundle_root(bundle_files):
    # Every bundle file lives under <repo>/...; take the repo root from bin/kani-driver.
    for f in bundle_files:
        if f.path.endswith("/bin/kani-driver"):
            return f.path[:-len("/bin/kani-driver")]
    fail("@kani bundle has no bin/kani-driver")

def _kani_crate_aspect_impl(target, ctx):
    if CrateInfo not in target:
        return []
    info = target[CrateInfo]
    if info.proc_macro_deps.to_list():
        fail("rust_kani_test: %s has proc-macro deps, which Kani-under-Bazel doesn't support yet" % target.label)
    deps = [d for d in getattr(ctx.rule.attr, "deps", []) if KaniCrateInfo in d]
    dep_externs = [struct(name = d[KaniCrateInfo].crate_name, rmeta = d[KaniCrateInfo].rmeta) for d in deps]
    dep_rmetas = depset(
        [e.rmeta for e in dep_externs],
        transitive = [d[KaniCrateInfo].dep_rmetas for d in deps],
    )
    rmeta = ctx.actions.declare_file("_kani/{}/lib{}.rmeta".format(target.label.name, info.name))
    bundle = ctx.files._bundle
    root = _bundle_root(bundle)
    args = ctx.actions.args()
    args.add_all(["--crate-name", info.name, "--edition=" + info.edition, "--crate-type", "lib"])
    args.add(info.root)
    args.add("--emit=metadata=" + rmeta.path)
    args.add_all([f.format(bundle = root) for f in _KANI_FLAGS])
    args.add("-Cllvm-args=--check-version=" + ctx.attr._version)
    for e in dep_externs:
        args.add("--extern", "{}={}".format(e.name, e.rmeta.path))
    args.add_all(dep_rmetas, map_each = _dep_dir, uniquify = True)
    ctx.actions.run(
        executable = ctx.executable._kani_compiler,
        arguments = [args],
        inputs = depset(bundle, transitive = [info.srcs, dep_rmetas]),
        outputs = [rmeta],
        env = {"RUSTC_BOOTSTRAP": "1"},
        mnemonic = "KaniCompile",
        progress_message = "Kani-compiling %{label}",
    )
    return [KaniCrateInfo(
        crate_name = info.name,
        rmeta = rmeta,
        dep_externs = dep_externs,
        dep_rmetas = dep_rmetas,
    )]

def _dep_dir(f):
    return "-Ldependency=" + f.dirname

_kani_crate_aspect = aspect(
    implementation = _kani_crate_aspect_impl,
    attr_aspects = ["deps"],
    attrs = {
        "_bundle": attr.label(default = "@kani//:bundle"),
        "_kani_compiler": attr.label(
            default = "@kani//:bin/kani-compiler",
            executable = True,
            cfg = "exec",
            allow_single_file = True,
        ),
        "_version": attr.string(default = "0.68.0"),
    },
)

def _shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"

def _rust_kani_test_impl(ctx):
    crate = ctx.attr.crate[CrateInfo]
    kinfo = ctx.attr.crate[KaniCrateInfo]
    srcs = crate.srcs.to_list()
    driver = ctx.file._driver
    harness_flags = " ".join(["--harness " + _shell_quote(h) for h in ctx.attr.harnesses])

    # RUSTFLAGS entries are runfiles-relative here and made absolute in the
    # script (it cds into the staging dir). Kani splits RUSTFLAGS on single
    # spaces, so no entry may contain one.
    flags = ["--edition=" + crate.edition]
    for e in kinfo.dep_externs:
        flags.append("--extern={}=$runfiles/{}".format(e.name, e.rmeta.short_path))
    dirs = {}
    for f in kinfo.dep_rmetas.to_list():
        dirs[f.short_path.rpartition("/")[0]] = True
    flags += ["-Ldependency=$runfiles/" + d for d in dirs]
    for f in flags:
        if " " in f:
            fail("rust_kani_test: RUSTFLAGS entry with a space: %r" % f)

    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        output = script,
        is_executable = True,
        content = """#!/usr/bin/env bash
set -euo pipefail
runfiles="$PWD"
work="$(mktemp -d "${{TEST_TMPDIR:-/tmp}}/kani.XXXXXX")"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$work/$(dirname "$f")"
  cp -L "$runfiles/$f" "$work/$f"
done <<'SRCS'
{srcs}
SRCS
driver="$runfiles/{driver}"
# goto-cc / goto-instrument / cbmc are found on PATH, next to kani-driver.
export PATH="$(dirname "$driver"):$PATH"
# Kani splits RUSTFLAGS on single spaces (an empty field becomes an empty
# input-file argument), so join without stray separators.
export RUSTFLAGS="{flags}${{RUSTFLAGS:+ $RUSTFLAGS}}"
cd "$work"
exec "$driver" {root} {harness_flags} "$@"
""".format(
            srcs = "\n".join([f.short_path for f in srcs]),
            driver = driver.short_path,
            flags = " ".join(flags),
            root = _shell_quote(crate.root.short_path),
            harness_flags = harness_flags,
        ),
    )
    runfiles = ctx.runfiles(
        files = srcs + ctx.files._bundle,
        transitive_files = kinfo.dep_rmetas,
    )
    return [DefaultInfo(executable = script, runfiles = runfiles)]

rust_kani_test = rule(
    implementation = _rust_kani_test_impl,
    test = True,
    attrs = {
        "crate": attr.label(
            mandatory = True,
            providers = [CrateInfo],
            aspects = [_kani_crate_aspect],
            doc = "The rust_library whose #[cfg(kani)] proofs to verify.",
        ),
        "harnesses": attr.string_list(
            doc = "Harness name filters (kani --harness); empty runs every harness.",
        ),
        "_bundle": attr.label(default = "@kani//:bundle"),
        "_driver": attr.label(
            default = "@kani//:bin/kani-driver",
            allow_single_file = True,
        ),
    },
    doc = "Verify a rust_library's Kani harnesses with a hermetic Kani (deps rebuilt by kani-compiler).",
)
