"""Package a TouchDesigner Custom OP shim into the format each OS's TD loads.

TouchDesigner loads Custom Operators differently per platform:

  * **macOS** wants a *bundle*: a `Foo.plugin/` directory containing
    `Contents/Info.plist` and `Contents/MacOS/Foo`. A bare `.dylib` in the
    Plugins folder is ignored. This mirrors what the reference CMake build
    (`add_library(... MODULE)` + `BUNDLE TRUE`) produces.
  * **Windows** loads a bare `Foo.dll` directly — no wrapper needed.

`td_plugin()` compiles the C++ shim once (as a `cc_binary(linkshared)`, which
statically links the Rust C-ABI core in) and then exposes a single public label
that resolves, per platform, to the loadable artifact:

  * macOS  -> `<Name>.plugin` bundle (a tree artifact) via `_td_macos_plugin`.
  * Windows -> the shared library (`.dll`) directly.

The shim links no TouchDesigner library — the SDK is header-only for building a
Custom OP (TD resolves everything through pointers passed into the operator at
runtime), which is why the resulting bundle has no undefined TD symbols.

Only macOS/Windows can produce a loadable plugin, so the compile target is
platform-gated; on Linux (CI / this container) the public alias resolves as
incompatible and is skipped by `//...`.
"""

load("@rules_cc//cc:cc_binary.bzl", "cc_binary")

# Only macOS/Windows can build a loadable TouchDesigner plugin.
_TD_PLATFORMS = select({
    "@platforms//os:osx": [],
    "@platforms//os:windows": [],
    "//conditions:default": ["@platforms//:incompatible"],
})

def _shared_lib(files):
    """The single loadable shared object among a cc_binary's outputs."""
    for f in files:
        if f.extension in ("dylib", "so", "dll"):
            return f

    # Fallback: cc_binary(linkshared) always emits exactly one lib artifact.
    return files[0]

def _td_macos_plugin_impl(ctx):
    src = _shared_lib(ctx.files.src)
    name = ctx.attr.bundle_name

    plist = ctx.actions.declare_file(name + "_Info.plist")
    ctx.actions.expand_template(
        template = ctx.file.info_plist_tpl,
        output = plist,
        substitutions = {
            "{EXECUTABLE}": name,
            "{IDENTIFIER}": ctx.attr.bundle_id,
            "{NAME}": name,
        },
    )

    bundle = ctx.actions.declare_directory(name + ".plugin")
    ctx.actions.run_shell(
        inputs = [src, plist],
        outputs = [bundle],
        command = (
            "set -euo pipefail\n" +
            'mkdir -p "{b}/Contents/MacOS"\n' +
            'cp "{src}" "{b}/Contents/MacOS/{name}"\n' +
            'cp "{plist}" "{b}/Contents/Info.plist"\n'
        ).format(b = bundle.path, src = src.path, name = name, plist = plist.path),
        mnemonic = "TdMacOsPlugin",
        progress_message = "Assembling %s.plugin" % name,
    )
    return [DefaultInfo(files = depset([bundle]))]

_td_macos_plugin = rule(
    implementation = _td_macos_plugin_impl,
    doc = "Wrap a built shared library into a macOS `<name>.plugin` bundle.",
    attrs = {
        "src": attr.label(
            mandatory = True,
            doc = "The cc_binary(linkshared) target to embed.",
        ),
        "bundle_name": attr.string(
            mandatory = True,
            doc = "Bundle + executable name (CFBundleExecutable / CFBundleName).",
        ),
        "bundle_id": attr.string(
            mandatory = True,
            doc = "CFBundleIdentifier (reverse-DNS).",
        ),
        "info_plist_tpl": attr.label(
            allow_single_file = True,
            default = Label("//tools/touchdesigner/plugin:Info.plist.tpl"),
        ),
    },
)

def td_plugin(name, srcs, bundle_name, bundle_id, deps = [], **kwargs):
    """A TouchDesigner Custom OP plugin, packaged for each platform.

    Args:
      name: public label; resolves to the loadable artifact for the host OS
        (a `.plugin` bundle on macOS, a `.dll` on Windows).
      srcs: the C++ shim sources/headers.
      bundle_name: macOS bundle + executable name (e.g. "LedMapperTexture").
      bundle_id: macOS CFBundleIdentifier (e.g. "com.ledmapper.texture").
      deps: cc deps (the Rust C-ABI core + the TD SDK headers).
      **kwargs: forwarded to the underlying cc_binary.
    """
    cc_binary(
        name = name + ".shared",
        srcs = srcs,
        linkshared = True,
        target_compatible_with = _TD_PLATFORMS,
        deps = deps,
        **kwargs
    )

    _td_macos_plugin(
        name = name + ".macos",
        src = ":" + name + ".shared",
        bundle_name = bundle_name,
        bundle_id = bundle_id,
        target_compatible_with = select({
            "@platforms//os:osx": [],
            "//conditions:default": ["@platforms//:incompatible"],
        }),
    )

    # One public label; the loadable artifact differs by OS. Windows loads the
    # bare .dll; macOS loads the .plugin bundle. Linux -> incompatible (skipped).
    native.alias(
        name = name,
        actual = select({
            "@platforms//os:osx": ":" + name + ".macos",
            "@platforms//os:windows": ":" + name + ".shared",
            "//conditions:default": ":" + name + ".shared",
        }),
    )
