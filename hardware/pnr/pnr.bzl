"""Bazel rules for the end-to-end algorithmic PnR flow (design §8, Phase 5).

`atopile_pnr` turns a resolved (row-placed) atopile board into a **placed, routed,
fab-ready** board and its manufacturing bundle — the single build target the
design promises:

    bazel build //hardware/splanc_dev:splanc_dev.fab

It stitches together the two interpreters the flow needs (design §11): KiCad's
`pcbnew` python (`@kicad_python`, via the atopile toolchain) for board I/O and the
detailed router, and the hermetic rules_python + torch binary (`//hardware/pnr:
pnr_fab`) for the place↔route optimization. One action runs, in order:

  1. ingest    (pcbnew)     resolved .kicad_pcb            -> graph.json
  2. place+route (torch)    graph.json + constraints.yaml  -> placed.json   (§4/§6 loop)
  3. writeback (pcbnew)     placed.json                    -> placed .kicad_pcb (+ Edge.Cuts)
  4. detail route (pcbnew + FreeRouting)                   -> routed .kicad_pcb
  5. DRC + export (kicad-cli)                              -> fab bundle dir

The board rule re-provides `AtopileLayoutInfo`, so the routed board flows into the
same hermetic exporters used by `atopile_project`. This replaces the naive-row
"autoroute preview" with a real optimized layout while keeping one-target UX.
"""

load("@atopile_rules//bazel/atopile:providers.bzl", "AtopileLayoutInfo")

TOOLCHAIN_TYPE = "@atopile_rules//bazel/atopile:toolchain_type"

# Reports the PnR board rule produces alongside the routed board, so the fab
# bundle can collect them (DRC report + the Phase 6 quality report).
PnrReportsInfo = provider(
    doc = "Side-car reports from the PnR board flow.",
    fields = {
        "drc": "File: the kicad-cli DRC report.",
        "quality": "File: routed length / via / diff-pair / length-match report.",
    },
)

def _toolinfo(ctx):
    return ctx.toolchains[TOOLCHAIN_TYPE].atopileinfo

def _kicad_cli(info):
    return info.kicad_cli.path if info.kicad_cli else info.kicad_cli_path

def _tool_inputs(info):
    extra = []
    if info.kicad_cli:
        extra.append(info.kicad_cli)
    if info.kicad_python:
        extra.append(info.kicad_python)
    return depset(direct = extra, transitive = [info.runfiles])

# Shell that binds $_KI_PY to a pcbnew-capable interpreter and $_KI_PP to the
# PYTHONPATH the pcbnew steps need (KiCad's `pcbnew` site-packages + the stdlib
# pnr package). Mirrors rules_atopile's autoroute step (KiCad ships pcbnew as a
# module, no standalone interpreter). $_KI_PP is applied *per pcbnew command*
# (see _ki_run), NOT exported — so it never leaks into the hermetic torch placer,
# whose own runfiles carry numpy/torch/pnr.
def _pcbnew_env(info, pnr_pp_file):
    ki_py = info.kicad_python.path if info.kicad_python else ""
    ki_cli = _kicad_cli(info)
    return "\n".join([
        '_KI_CLI="%s"' % ki_cli,
        'command -v "$_KI_CLI" >/dev/null 2>&1 && _KI_CLI="$(command -v "$_KI_CLI")"',
        '_KI_ROOT="$(cd "$(dirname "$(readlink -f "$_KI_CLI")")/.." 2>/dev/null && pwd || true)"',
        '_KI_SP="$(ls -d "$_KI_ROOT"/lib/python3*/site-packages 2>/dev/null | head -1)"',
        # PNR package dir: parent of the dir holding graph.py (…/hardware/pnr).
        '_PNR_PP="$(cd "$(dirname "$(dirname \'%s\')")" && pwd)"' % pnr_pp_file.path,
        '_KI_PP="${_KI_SP:+$_KI_SP:}$_PNR_PP"',
        '_KI_PY="%s"' % ki_py,
        'if [ -z "$_KI_PY" ] || ! PYTHONPATH="$_KI_PP" "$_KI_PY" -c "import pcbnew" >/dev/null 2>&1; then',
        '  for _c in "${KICAD_PYTHON:-}" python3; do',
        '    if [ -n "$_c" ] && command -v "$_c" >/dev/null 2>&1 && PYTHONPATH="$_KI_PP" "$_c" -c "import pcbnew" >/dev/null 2>&1; then _KI_PY="$_c"; break; fi',
        "  done",
        "fi",
        '[ -n "$_KI_PY" ] || { echo "pnr: no pcbnew-capable python (set toolchain kicad_python / KICAD_PYTHON)" >&2; exit 1; }',
    ])

# Run a pcbnew step: the kicad python with the (non-exported) pcbnew PYTHONPATH.
def _ki_run(args):
    return 'PYTHONPATH="$_KI_PP" "$_KI_PY" ' + args

def _graph_py(ctx):
    for f in ctx.files._pnr_srcs:
        if f.basename == "graph.py":
            return f
    fail("pnr: graph.py not found among _pnr_srcs")

# -- board rule: run the full PnR pipeline -> routed .kicad_pcb ----------------

def _pnr_board_impl(ctx):
    info = _toolinfo(ctx)
    in_pcb = ctx.attr.layout[AtopileLayoutInfo].pcb
    bom = ctx.attr.layout[AtopileLayoutInfo].bom
    out_pcb = ctx.actions.declare_file(ctx.label.name + ".kicad_pcb")
    drc_rpt = ctx.actions.declare_file(ctx.label.name + ".drc.rpt")
    quality_rpt = ctx.actions.declare_file(ctx.label.name + ".quality.txt")

    fr = ctx.file.freerouting
    placer = ctx.executable.placer
    autoroute = ctx.file._autoroute
    graph_py = _graph_py(ctx)
    name = ctx.attr.board_name or ctx.label.name
    mp = ctx.attr.route_max_passes

    drc_severity = "--exit-code-violations" if ctx.attr.drc_gate else ""

    cmd = "\n".join([
        "set -euo pipefail",
        'export HOME="${HOME:-$(mktemp -d)}"',
        "_WORK=\"$(mktemp -d)\"",
        _pcbnew_env(info, graph_py),
        '_FR="$(cd "$(dirname \'%s\')" && pwd)/$(basename \'%s\')"' % (fr.path, fr.path),
        # 1. ingest: resolved board -> neutral graph.
        _ki_run('-m pnr.ingest "%s" --name "%s" --dump-json "$_WORK/graph.json"' % (in_pcb.path, name)),
        # 2. place + route feedback loop (torch) -> placed graph + routing rules
        # (net classes / diff pairs / length match). Runs with its OWN runfiles
        # env (no injected PYTHONPATH).
        '"%s" "$_WORK/graph.json" "%s" --dump-json "$_WORK/placed.json" --dump-rules "$_WORK/rules.json" %s' % (
            placer.path,
            ctx.file.constraints.path,
            "--allow-unconverged" if ctx.attr.allow_unconverged else "",
        ),
        # 3. writeback the optimized placement + net classes onto the board, and
        # frame Edge.Cuts to the placement region (all pads inside; set layer count).
        _ki_run('-m pnr.writeback "%s" "$_WORK/placed.json" --out "%s" --rules "$_WORK/rules.json"' % (in_pcb.path, out_pcb.path)),
        # 4. detailed route (FreeRouting DSN/SES) — routes tracks into the board.
        _ki_run('"%s" "%s" "$_FR" %d' % (autoroute.path, out_pcb.path, mp)),
        # 4b. pour ground/power planes + via-stitch their pads (after routing:
        # FreeRouting's SES round-trip drops pre-poured zones).
        _ki_run('-m pnr.planes "%s" --rules "$_WORK/rules.json"' % out_pcb.path),
        # 5. DRC report (gated iff drc_gate).
        '"%s" pcb drc "%s" -o "%s" --format report %s || _DRC=$?' % (
            _kicad_cli(info),
            out_pcb.path,
            drc_rpt.path,
            drc_severity,
        ),
        'if [ -n "${_DRC:-}" ] && [ "${_DRC}" != "0" ]; then',
        '  echo "pnr: DRC reported violations (see %s)" >&2' % drc_rpt.short_path,
        "  " + ("exit \"$_DRC\"" if ctx.attr.drc_gate else "true"),
        "fi",
        # Ensure the report file exists even when kicad-cli wrote nothing.
        '[ -f "%s" ] || : > "%s"' % (drc_rpt.path, drc_rpt.path),
        # 6. quality pass: routed length / vias / diff-pair skew / length-match,
        # AND the routing-completeness gate — fail the build if any net is unrouted
        # (unless require_routed is off). A partial route is not a board.
        _ki_run('-m pnr.quality "%s" --rules "$_WORK/rules.json" --out "%s" %s %s' % (
            out_pcb.path,
            quality_rpt.path,
            "--gate" if ctx.attr.quality_gate else "",
            "--require-routed" if ctx.attr.require_routed else "",
        )),
    ])

    inputs = depset(
        direct = [in_pcb, ctx.file.constraints, fr, autoroute, graph_py] +
                 ctx.files._pnr_srcs,
        transitive = [_tool_inputs(info)],
    )

    ctx.actions.run_shell(
        outputs = [out_pcb, drc_rpt, quality_rpt],
        inputs = inputs,
        # files_to_run stages the placer py_binary AND its runfiles tree.
        tools = [ctx.attr.placer[DefaultInfo].files_to_run],
        command = cmd,
        mnemonic = "PnrBoard",
        progress_message = "PnR place+route -> %s" % out_pcb.short_path,
        use_default_shell_env = True,
        # Non-hermetic like the atopile actions: FreeRouting is a JVM subprocess
        # and pcbnew resolves against the nix store; keep it local/no-sandbox.
        execution_requirements = {"local": "1", "no-sandbox": "1"},
    )
    return [
        DefaultInfo(files = depset([out_pcb, drc_rpt, quality_rpt])),
        AtopileLayoutInfo(pcb = out_pcb, bom = bom),
        PnrReportsInfo(drc = drc_rpt, quality = quality_rpt),
    ]

_pnr_board = rule(
    implementation = _pnr_board_impl,
    attrs = {
        "layout": attr.label(providers = [AtopileLayoutInfo], mandatory = True, doc = "Resolved atopile board to place+route."),
        "constraints": attr.label(allow_single_file = [".yaml", ".yml"], mandatory = True, doc = "Sidecar constraints.yaml (design §3)."),
        "placer": attr.label(executable = True, cfg = "exec", mandatory = True, doc = "The torch place+route py_binary (//hardware/pnr:pnr_fab)."),
        "freerouting": attr.label(allow_single_file = True, mandatory = True, doc = "FreeRouting binary for the detailed route."),
        "route_max_passes": attr.int(default = 0, doc = "Cap FreeRouting optimization passes (`-mp`); 0 = route to completion."),
        "board_name": attr.string(doc = "Board name recorded in the graph (default: target name)."),
        "allow_unconverged": attr.bool(default = True, doc = "Proceed even if the place↔route loop did not drive overflow to 0."),
        "drc_gate": attr.bool(default = False, doc = "Fail the build on DRC violations (else report only)."),
        "quality_gate": attr.bool(default = False, doc = "Fail the build if a diff-pair/length-match check fails (else report only)."),
        "require_routed": attr.bool(default = True, doc = "Fail the build if any net is left unrouted (the routing-completeness gate)."),
        "_pnr_srcs": attr.label(default = "//hardware/pnr:pnr_kicad_srcs", doc = "Stdlib pnr sources for the pcbnew steps."),
        "_autoroute": attr.label(default = "@atopile_rules//tools:autoroute.py", allow_single_file = True),
    },
    toolchains = [TOOLCHAIN_TYPE],
)

# -- fab bundle: kicad-cli exports off the routed board -> one vendor dir -------

def _pnr_fab_impl(ctx):
    info = _toolinfo(ctx)
    layout = ctx.attr.board[AtopileLayoutInfo]
    reports = ctx.attr.board[PnrReportsInfo]
    pcb = layout.pcb
    bom = layout.bom
    drc = reports.drc
    quality = reports.quality
    outdir = ctx.actions.declare_directory(ctx.label.name)
    kc = _kicad_cli(info)

    cmd = "\n".join([
        "set -euo pipefail",
        'export HOME="${HOME:-$(mktemp -d)}"',
        'mkdir -p "%s"' % outdir.path,
        # The routed board itself, for reference / hand-off.
        'cp -f "%s" "%s/"' % (pcb.path, outdir.path),
        '"%s" pcb export gerbers "%s" -o "%s/"' % (kc, pcb.path, outdir.path),
        '"%s" pcb export drill "%s" -o "%s/"' % (kc, pcb.path, outdir.path),
        '"%s" pcb export pos "%s" -o "%s/pick-place.csv" --format csv --units mm || true' % (kc, pcb.path, outdir.path),
        'if [ -s "%s" ]; then cp -f "%s" "%s/bom.csv"; fi' % (bom.path, bom.path, outdir.path),
        # The DRC + Phase 6 quality reports travel with the bundle.
        'cp -f "%s" "%s/drc.rpt"' % (drc.path, outdir.path),
        'cp -f "%s" "%s/quality.txt"' % (quality.path, outdir.path),
    ])

    ctx.actions.run_shell(
        outputs = [outdir],
        inputs = depset([pcb, bom, drc, quality], transitive = [_tool_inputs(info)]),
        command = cmd,
        mnemonic = "PnrFab",
        progress_message = "PnR fab bundle -> %s" % outdir.short_path,
        use_default_shell_env = True,
        execution_requirements = {"local": "1", "no-sandbox": "1"},
    )
    return [DefaultInfo(files = depset([outdir]))]

_pnr_fab = rule(
    implementation = _pnr_fab_impl,
    attrs = {
        "board": attr.label(providers = [AtopileLayoutInfo, PnrReportsInfo], mandatory = True),
    },
    toolchains = [TOOLCHAIN_TYPE],
)

def atopile_pnr(
        name,
        layout,
        constraints,
        route_max_passes = 0,
        drc_gate = False,
        quality_gate = False,
        require_routed = True,
        allow_unconverged = True,
        board_name = None,
        visibility = None,
        tags = []):
    """Declare the end-to-end PnR fab flow for a resolved atopile board.

    Creates `<name>` (the fab bundle: routed board + Gerbers + drill + pick-place
    + BOM) and `<name>.board` (the routed `.kicad_pcb` + DRC report). Building
    `<name>` runs the whole optimize→route→export pipeline.

    Args:
      name: base target name (e.g. `splanc_dev.fab`).
      layout: the `atopile_project` base target (provides the resolved board).
      constraints: the sidecar `constraints.yaml` (design §3).
      route_max_passes: cap FreeRouting passes (`-mp`); 0 = route to completion.
      drc_gate: fail the build on DRC violations (default: report only).
      quality_gate: fail the build if a diff-pair/length-match check fails.
      require_routed: fail the build if any net is left unrouted (default True).
      allow_unconverged: proceed even if the place↔route loop leaves overflow.
      board_name: board name stamped into the graph (default: `<name>.board`).
      visibility: standard Bazel visibility, applied to both sub-targets.
      tags: extra tags applied to both sub-targets.
    """
    _pnr_board(
        name = name + ".board",
        layout = layout,
        constraints = constraints,
        placer = "//hardware/pnr:pnr_fab",
        freerouting = "@freerouting//:bin/freerouting",
        route_max_passes = route_max_passes,
        drc_gate = drc_gate,
        quality_gate = quality_gate,
        require_routed = require_routed,
        allow_unconverged = allow_unconverged,
        board_name = board_name,
        visibility = visibility,
        tags = tags,
    )
    _pnr_fab(
        name = name,
        board = ":" + name + ".board",
        visibility = visibility,
        tags = tags,
    )
