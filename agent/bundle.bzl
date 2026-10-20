"""The agent bundle: splanc-agent-<ver>.tgz + its sha256 (spec "Bundle layout").

    splanc-agent-<ver>/
      bundle.json   package.json   proto/   mcp/   compiler/   simulator/   skill/
      site/         the website's agent entry point, rendered here (README "Site files")

package.json makes the tgz an npm package with a `splanc-agent` bin, so
`npx -y <url of the tgz>` runs the hub with no install step.

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

def _strip(f, prefix):
    rel = f.short_path
    return rel[len(prefix):] if prefix and rel.startswith(prefix) else f.basename

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

    pkg = ctx.actions.declare_file(ctx.label.name + ".package.json")
    ctx.actions.write(pkg, json.encode_indent({
        "name": "@splanc/agent",
        "version": ver,
        "description": "Splanc hub: drive every Splanc LED player on the LAN from an AI agent (MCP server + CLI).",
        "type": "module",
        "bin": {"splanc-agent": "mcp/splanc-agent.mjs"},
        "engines": {"node": ">=20"},
        "license": "UNLICENSED",
    }, indent = "  ") + "\n")

    # The site files, rendered from the bundle's own sources so the website can't
    # drift from what it installs. The tgz's sha256 can't be inside the tgz:
    # latest.json says null and the site's stager fills it from the .sha256 asset.
    base = ctx.attr.site_base[BuildSettingInfo].value.rstrip("/")
    tgz_url = base + "/agent/splanc-agent.tgz"
    skill_rel = [_strip(f, ctx.attr.skill_strip) for f in ctx.files.skill]
    subs = {
        "{{BASE_URL}}": base,
        "{{TGZ_URL}}": tgz_url,
        "{{NPX}}": "npx -y " + tgz_url,
        "{{VERSION}}": ver,
        "{{FIRMWARE_MIN}}": ver,
        "{{FIRMWARE_MAX}}": ver,
        "{{SKILL_INDEX}}": "\n".join(["- [{r}]({b}/agent/skill/{r})".format(r = r, b = base) for r in sorted(skill_rel)]),
    }
    site = []  # (path under site/, file)
    for t in ctx.files.site_templates:
        name = t.basename.removesuffix(".tmpl")
        out = ctx.actions.declare_file(ctx.label.name + ".site/" + name)
        ctx.actions.expand_template(template = t, output = out, substitutions = subs)
        site.append((".well-known/mcp/server.json" if name == "server.json" else name, out))
    latest = ctx.actions.declare_file(ctx.label.name + ".site/latest.json")
    ctx.actions.write(latest, json.encode_indent({
        "schema": "splanc-agent-latest/1",
        "version": ver,
        "release": "firmware-v" + ver,
        "url": tgz_url,
        "asset": stem + ".tgz",
        "sha256": None,
        "firmware": {"min": ver, "max": ver},
        "install": {
            "mcp": "claude mcp add splanc -- npx -y " + tgz_url,
            "cli": "npx -y " + tgz_url + " list-players",
        },
        "skill": base + "/agent/skill/SKILL.md",
    }, indent = "  ") + "\n")
    site.append(("agent/latest.json", latest))

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
    cmds.append("cp {} \"$B/package.json\"".format(pkg.path))
    inputs = [manifest, pkg]
    site += [("agent/skill/" + r, f) for f, r in zip(ctx.files.skill, skill_rel)]
    for rel, f in site:
        inputs.append(f)
        cmds.append("mkdir -p \"$(dirname \"$B/site/{r}\")\" && cp -L {s} \"$B/site/{r}\"".format(r = rel, s = f.path))
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
        "chmod 0755 \"$B/mcp/splanc-agent.mjs\"",
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
        "site_base": attr.label(mandatory = True, doc = "string_flag: the website the site files name"),
        "site_templates": attr.label_list(allow_files = [".tmpl"], doc = "AGENTS.md / llms.txt / server.json templates"),
        "skill_strip": attr.string(doc = "short_path prefix stripped from skill files"),
        "version": attr.label(mandatory = True),
    },
)
