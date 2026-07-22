"""jinja_template — Jinja2 template expansion as a first-class rule.

Replaces the sed-pipeline genrules that used to bake build constants into
shipped resources (`%%VAR%%` placeholders). A real template rule buys:

  - **Loud failure on a missing variable.** sed silently ships an
    unsubstituted `%%VAR%%` (only caught if a test happens to grep for it);
    the expander runs Jinja with StrictUndefined, so an undefined variable
    fails the BUILD.
  - **Real template semantics** — conditionals, loops, includes (via `deps`)
    — instead of ever-growing `-e 's|…|…|g'` chains.
  - **Hermetic quoting.** Values pass as argv, not through a shell command
    line, so `|`, `&` or quotes in a value can't corrupt the sed program.

The expander is //tools/jinja:expand (hermetic @pypi//jinja2 — no host
Python involved). Autoescaping is OFF by design: templates here produce the
literal artifact (HTML/config/source), and values are trusted build
constants, not user input.
"""

def _jinja_template_impl(ctx):
    args = ctx.actions.args()
    args.add("--template", ctx.file.template.path)
    args.add("--out", ctx.outputs.out.path)
    for key, value in ctx.attr.vars.items():
        args.add("--define", "{}={}".format(key, value))
    ctx.actions.run(
        executable = ctx.executable._expander,
        arguments = [args],
        inputs = depset([ctx.file.template], transitive = [depset(ctx.files.deps)]),
        outputs = [ctx.outputs.out],
        mnemonic = "JinjaExpand",
        progress_message = "Expanding Jinja template %{label}",
    )
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

jinja_template = rule(
    implementation = _jinja_template_impl,
    doc = "Expand a Jinja2 template with the given variables into `out`. " +
          "Undefined variables fail the build (StrictUndefined).",
    attrs = {
        "template": attr.label(
            allow_single_file = True,
            mandatory = True,
            doc = "The Jinja2 template file (conventionally *.j2).",
        ),
        "out": attr.output(
            mandatory = True,
            doc = "The expanded output file. Named explicitly because " +
                  "consumers may derive identifiers from the basename " +
                  "(e.g. c_resource_library symbol names).",
        ),
        "vars": attr.string_dict(
            doc = "Template variables. Values are strings; the template " +
                  "casts/branches as needed.",
        ),
        "deps": attr.label_list(
            allow_files = True,
            doc = "Templates reachable from `template` via {% include %} / " +
                  "{% import %} — referenced by workspace-relative path.",
        ),
        "_expander": attr.label(
            default = Label("//tools/jinja:expand"),
            executable = True,
            cfg = "exec",
        ),
    },
)
