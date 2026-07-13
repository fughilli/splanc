"""html_minify — HTML minification for resources baked into firmware flash.

The ESP32 serves its pages from C arrays compiled into the image
(c_resource_library), so every byte of markup costs flash AND airtime on a
SoftAP link; comments and indentation are pure waste there. This rule runs
tdewolff/minify (HTML + embedded CSS/JS) over a single file.

The minifier binary comes from the pinned nixpkgs snapshot (@minify,
declared in MODULE.bazel) — a single static Go binary, no host install.
NOTE: that makes `nix` a build-time requirement FOR TARGETS USING THIS RULE
(the repository is fetched lazily, so the rest of the repo still builds on
nix-less machines — see the Nix section of MODULE.bazel).
"""

def _html_minify_impl(ctx):
    args = ctx.actions.args()
    args.add("--type", "html")
    args.add("-o", ctx.outputs.out.path)
    args.add(ctx.file.src.path)
    ctx.actions.run(
        executable = ctx.file._minifier,
        arguments = [args],
        inputs = [ctx.file.src],
        tools = [ctx.file._minifier],
        outputs = [ctx.outputs.out],
        mnemonic = "HtmlMinify",
        progress_message = "Minifying %{input}",
    )
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

html_minify = rule(
    implementation = _html_minify_impl,
    doc = "Minify one HTML file (with embedded CSS/JS) using the " +
          "Nix-provided tdewolff/minify. Requires `nix` on the builder.",
    attrs = {
        "src": attr.label(
            allow_single_file = [".html", ".htm"],
            mandatory = True,
        ),
        "out": attr.output(
            mandatory = True,
            doc = "The minified output. Named explicitly because consumers " +
                  "may derive identifiers from the basename (e.g. " +
                  "c_resource_library symbol names).",
        ),
        "_minifier": attr.label(
            default = Label("@minify//:minify"),
            allow_single_file = True,
            cfg = "exec",
        ),
    },
)
