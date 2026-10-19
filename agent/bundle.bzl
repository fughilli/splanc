"""The agent bundle: splanc-agent-<ver>.tgz + its sha256 (spec "Bundle layout").

    splanc-agent-<ver>/
      bundle.json   proto/   mcp/   compiler/   simulator/   skill/

The version comes from the //agent:bundle_version build setting (the release
workflow passes the firmware tag's version; local builds say 0.0.0-dev, which
has no published bundle — the bridge then runs from a local checkout).
"""

load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")

def _agent_bundle_impl(ctx):
    ver = ctx.attr.version[BuildSettingInfo].value
    stem = "splanc-agent-" + ver

    # Named by version (known at analysis): the files ARE the release assets.
    tgz = ctx.actions.declare_file(stem + ".tgz")
    sha = ctx.actions.declare_file(stem + ".tgz.sha256")
    manifest = ctx.actions.declare_file(ctx.label.name + ".bundle.json")

    ctx.actions.write(manifest, json.encode_indent({
        "schema": "splanc-agent-bundle/1",
        "version": ver,
        # One bundle per firmware release: it speaks that release's protocol and
        # emits its bytecode. (Range, not a single version, so a patch release
        # that changes neither can reuse a bundle later.)
        "firmware": {"min": ver, "max": ver},
        "fxb_format": ctx.attr.fxb_format,
        "protocol": {"package": "ledmapper.v1", "proto": "proto/ledmapper.proto"},
        "mcp": {"command": "node", "args": ["mcp/splanc-agent.mjs", "--host", "{host}"], "node": ">=20"},
        "skill": "skill/SKILL.md",
    }, indent = "  ") + "\n")

    # (destination dir in the bundle, files or tree artifacts, strip prefix)
    groups = [
        ("mcp", [ctx.file.mcp], None),
        ("compiler", ctx.files.compiler, None),
        ("simulator", ctx.files.simulator, None),
        ("proto", [ctx.file.proto], None),
        ("skill", ctx.files.skill, ctx.attr.skill_strip),
    ]
    cmds = ["set -eu", "R=$(mktemp -d)", "B=\"$R/" + stem + "\"", "mkdir -p \"$B\""]
    cmds.append("cp {} \"$B/bundle.json\"".format(manifest.path))
    inputs = [manifest]
    for dest, files, strip in groups:
        for f in files:
            inputs.append(f)
            if f.is_directory:
                cmds.append("mkdir -p \"$B/{d}\" && cp -RL {s}/. \"$B/{d}/\"".format(d = dest, s = f.path))
                continue
            rel = f.short_path
            if strip and rel.startswith(strip):
                rel = rel[len(strip):]
            else:
                rel = f.basename
            if dest == "mcp":
                rel = "splanc-agent.mjs"
            cmds.append("mkdir -p \"$(dirname \"$B/{d}/{r}\")\" && cp -L {s} \"$B/{d}/{r}\"".format(d = dest, r = rel, s = f.path))
    cmds += [
        "chmod -R u+rwX,go+rX \"$B\"",
        # Reproducible: sorted, fixed mtime/owner, no gzip timestamp.
        "tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C \"$R\" -cf - " + stem +
        " | gzip -n -9 > " + tgz.path,
        "(cd $(dirname {t}) && sha256sum $(basename {t})) > {s}".format(t = tgz.path, s = sha.path),
        "rm -rf \"$R\"",
    ]
    ctx.actions.run_shell(
        outputs = [tgz, sha],
        inputs = inputs,
        command = "\n".join(cmds),
        mnemonic = "AgentBundle",
        progress_message = "Packing " + stem + ".tgz",
    )
    return [DefaultInfo(files = depset([tgz, sha]))]

agent_bundle = rule(
    implementation = _agent_bundle_impl,
    attrs = {
        "compiler": attr.label(mandatory = True, doc = "fx_compiler wasm package (dir)"),
        "fxb_format": attr.string(mandatory = True, doc = "the .fxb container magic this compiler emits"),
        "mcp": attr.label(mandatory = True, allow_single_file = True, doc = "the bundled bridge .mjs"),
        "proto": attr.label(mandatory = True, allow_single_file = True),
        "simulator": attr.label(mandatory = True, doc = "fx_vm wasm package (dir)"),
        "skill": attr.label_list(allow_files = True),
        "skill_strip": attr.string(doc = "short_path prefix stripped from skill files"),
        "version": attr.label(mandatory = True),
    },
)
