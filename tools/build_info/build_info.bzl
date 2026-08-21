"""build_info_file — stamp git build info into a generated source file.

Bazel's `--stamp` mechanism: //.bazelrc registers //tools/build_info/status.sh
as the `workspace_status_command`, which writes `STABLE_GIT_COMMIT` /
`STABLE_GIT_COMMIT_SHORT` / `STABLE_GIT_DIRTY[_JSON]` into stable-status.txt.
This rule reads that file (via `ctx.info_file`) and expands a template's
`@STABLE_...@` placeholders with the values, producing e.g. a firmware C header
(`#define LM_GIT_COMMIT ...`) or the web app's build-info JSON.

Depending on `ctx.info_file` (stable-status.txt) makes the action rerun only
when the STABLE_* keys change — i.e. on a new commit or a change to the dirty
state — not on every build. No `stamp` attribute / `--stamp` flag is needed:
the workspace status command runs regardless, and the stable keys are always
present because we register the command in .bazelrc.
"""

def _build_info_file_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out)
    args = ctx.actions.args()
    args.add("--status", ctx.info_file.path)
    args.add("--template", ctx.file.template.path)
    args.add("--out", out.path)
    ctx.actions.run(
        executable = ctx.executable._expander,
        arguments = [args],
        inputs = [ctx.info_file, ctx.file.template],
        outputs = [out],
        mnemonic = "BuildInfoStamp",
        progress_message = "Stamping build info %{label}",
    )
    return [DefaultInfo(files = depset([out]))]

build_info_file = rule(
    implementation = _build_info_file_impl,
    doc = "Expand a template's @STABLE_...@ placeholders with the git build " +
          "info from Bazel's workspace status (stable-status.txt) into `out`.",
    attrs = {
        "template": attr.label(
            allow_single_file = True,
            mandatory = True,
            doc = "Template file with @STABLE_GIT_*@ placeholders.",
        ),
        "out": attr.string(
            mandatory = True,
            doc = "Basename of the generated file (in this package).",
        ),
        "_expander": attr.label(
            default = Label("//tools/build_info:expand"),
            executable = True,
            cfg = "exec",
        ),
    },
)
