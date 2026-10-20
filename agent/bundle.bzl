"""The agent bundle: splanc-agent-<ver>.tgz + its sha256 (spec "Bundle layout").

    splanc-agent-<ver>/
      bundle.json   proto/   mcp/   compiler/   simulator/   skill/

The version comes from the //agent:bundle_version build setting (the release
workflow passes the firmware tag's version; local builds say 0.0.0-dev, which
has no published bundle — the bridge then runs from a local checkout).
"""

load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")

_PACK_PY = """import gzip, hashlib, io, os, sys, tarfile
root, stem, out, sha = sys.argv[1:5]
def norm(ti):
    ti.mtime = 0
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = ""
    return ti
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
    paths = [stem]
    for d, dirs, files in os.walk(os.path.join(root, stem)):
        dirs.sort()
        rel = os.path.relpath(d, root)
        paths += [os.path.join(rel, n) for n in sorted(dirs) + sorted(files)]
    for p in sorted(set(paths)):
        t.add(os.path.join(root, p), arcname=p, recursive=False, filter=norm)
with open(out, "wb") as f, gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0, filename="") as g:
    g.write(buf.getvalue())
digest = hashlib.sha256(open(out, "rb").read()).hexdigest()
open(sha, "w").write(digest + "  " + os.path.basename(out) + "\\n")
"""

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
        # Reproducible (sorted entries, zero mtimes/owners, no gzip timestamp) and
        # portable: Python's tarfile, not GNU tar's --sort/--mtime (macOS ships
        # bsdtar) or sha256sum (absent on macOS).
        "python3 - \"$R\" " + stem + " " + tgz.path + " " + sha.path + " <<'PY'\n" + _PACK_PY + "PY",
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
