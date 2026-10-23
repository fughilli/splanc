#!/usr/bin/env python3
"""Generate FX effects from fixed prompts with Claude (headless `claude -p`),
compile them with the host fx_compile, auto-repair on compile errors, and save
the final programs for analysis.

Variants (system context):
  app       in-app effect AI: SYSTEM_PROMPT from web/src/effects/ai/system-prompt.ts
  skill     MCP agent skill: agent/skill/{SKILL,effect-language,geometry,uniforms-and-ui}.md
            + agent/skill/examples/*.fx + an "offline, reply with source only" note
  app_perf  app + tools/fx_agent_eval/perf_addendum.txt appended
  app_lint  the `app` program for the same model/prompt, then ONE revision round
            feeding analyze.py's lint warnings back (kept only if it compiles)
  app2, skill2
            the same two paths rendered from the CURRENT tree. The committed `app` /
            `skill` runs are the fx-perf-study baseline (prompts before the R6
            cost-table fixes); `*2` are the after leg on the same 15 prompts.
  app2_est, skill2_est
            the `*2` program, then — only if the offline estimate (estimate.mjs,
            the cost model estimate_effect uses) is over the 33 ms frame — ONE
            revision round fed what estimate_effect returns: the estimate and the
            top cost findings (kept only if it compiles)

Outputs:
  firmware/fx_perf_bench/agent/<variant>__<model>__<pid>.fx   final program
  tools/fx_agent_eval/out/runs/<variant>__<model>__<pid>.json  raw replies + metadata
  tools/fx_agent_eval/out/system/<variant>.txt                 rendered system prompts

Stdlib only. Usage: see README.md.
"""
import argparse
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out")
RUNS = os.path.join(OUT, "runs")
SYSDIR = os.path.join(OUT, "system")
PROG_DIR = os.path.join(REPO, "firmware", "fx_perf_bench", "agent")
DEFAULT_FXC = os.path.expanduser("~/perf/fx_compile")

MODELS = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
}
MAX_REPAIRS = 2
CALL_TIMEOUT_S = 900

SKILL_OFFLINE_NOTE = """
---
OFFLINE EVALUATION RUN: the splanc-agent device tools (list_players, preview_effect,
measure_effect, deploy_effect, search_effects, ...) are NOT available in this run and
you cannot read the fixture resources — the fixture is described in the request.
Write a NEW effect for the request. Reply with ONLY the complete effect source in a
single ```glsl code block, no other text.
"""

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def safe(s):
    return re.sub(r"[^a-z0-9_]", "_", s.lower())


# --------------------------------------------------------------------------- prompts


def render_app_prompt():
    """SYSTEM_PROMPT via node --experimental-strip-types (node >= 22)."""
    d = tempfile.mkdtemp(prefix="fxsp-")
    try:
        shutil.copy(os.path.join(REPO, "web/src/effects/editor/lang-spec.ts"), d)
        src = open(os.path.join(REPO, "web/src/effects/ai/system-prompt.ts")).read()
        src = src.replace('"../editor/lang-spec"', '"./lang-spec.ts"')
        open(os.path.join(d, "system-prompt.ts"), "w").write(src)
        open(os.path.join(d, "render.mts"), "w").write(
            'import { SYSTEM_PROMPT } from "./system-prompt.ts";\n'
            'import { writeFileSync } from "node:fs";\n'
            "writeFileSync(process.argv[2], SYSTEM_PROMPT);\n"
        )
        out = os.path.join(d, "out.txt")
        subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", "render.mts", out],
            cwd=d,
            check=True,
            capture_output=True,
        )
        return open(out).read()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def render_skill_prompt():
    sk = os.path.join(REPO, "agent", "skill")
    parts = []
    for name in ["SKILL.md", "effect-language.md", "geometry.md", "uniforms-and-ui.md"]:
        parts.append(f"===== {name} =====\n" + open(os.path.join(sk, name)).read())
    exd = os.path.join(sk, "examples")
    for name in sorted(os.listdir(exd)):
        if name.endswith(".fx"):
            parts.append(f"===== examples/{name} =====\n" + open(os.path.join(exd, name)).read())
    return "\n\n".join(parts) + "\n" + SKILL_OFFLINE_NOTE


def system_prompt(variant, cache={}):
    if variant in cache:
        return cache[variant]
    if variant in ("app", "app_lint", "app2", "app2_est"):
        sp = render_app_prompt()
    elif variant == "app_perf":
        sp = system_prompt("app") + "\n\n" + open(os.path.join(HERE, "perf_addendum.txt")).read()
    elif variant in ("skill", "skill2", "skill2_est"):
        sp = render_skill_prompt()
    else:
        raise SystemExit(f"unknown variant {variant}")
    cache[variant] = sp
    os.makedirs(SYSDIR, exist_ok=True)
    open(os.path.join(SYSDIR, f"{variant}.txt"), "w").write(sp)
    return sp


# --------------------------------------------------------------------------- claude + compile


def call_claude(model, sys_file, message, workdir, resume=None):
    cmd = [
        "claude",
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--system-prompt-file",
        sys_file,
        "--model",
        model,
        "--output-format",
        "json",
    ]
    if resume:
        cmd += ["--resume", resume]
    t0 = time.time()
    p = subprocess.run(
        cmd + [message], cwd=workdir, capture_output=True, text=True, timeout=CALL_TIMEOUT_S
    )
    wall = time.time() - t0
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {
            "error": f"rc={p.returncode} non-json output: {p.stdout[-400:]} {p.stderr[-400:]}",
            "wall_s": round(wall, 1),
        }
    u = d.get("usage") or {}
    return {
        "text": d.get("result") or "",
        "is_error": d.get("is_error", False),
        "session_id": d.get("session_id"),
        "wall_s": round(wall, 1),
        "duration_api_ms": d.get("duration_api_ms"),
        "cost_usd": d.get("total_cost_usd"),
        "models_used": list((d.get("modelUsage") or {}).keys()),
        "usage": {
            k: u.get(k)
            for k in (
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            )
        },
        "thinking_tokens": (u.get("output_tokens_details") or {}).get("thinking_tokens"),
    }


FENCE = re.compile(r"```([A-Za-z0-9_+-]*)[^\n]*\n(.*?)```", re.S)


def extract_program(text):
    blocks = FENCE.findall(text)
    for lang, body in blocks:
        if lang.lower() in ("glsl", "c", "fx", "cpp", ""):
            return body.strip() + "\n"
    if blocks:
        return blocks[0][1].strip() + "\n"
    return text.strip() + "\n"


DIAG = re.compile(r'line:\s*(\d+),\s*col:\s*(\d+),\s*msg:\s*"((?:[^"\\]|\\.)*)"')


def compile_src(fxc, src):
    with tempfile.TemporaryDirectory() as d:
        sp = os.path.join(d, "e.fx")
        open(sp, "w").write(src)
        p = subprocess.run([fxc, sp, os.path.join(d, "e.fxb")], capture_output=True, text=True)
        if p.returncode == 0:
            return True, [], os.path.getsize(os.path.join(d, "e.fxb"))
        diags = [
            {"line": int(a), "col": int(b), "msg": m.encode().decode("unicode_escape")}
            for a, b, m in DIAG.findall(p.stderr)
        ]
        if not diags:
            diags = [{"line": 0, "col": 0, "msg": p.stderr.strip()[-500:] or f"rc={p.returncode}"}]
        return False, diags, None


def repair_message(script, diags):
    # Mirrors web/src/effects/ai/generate.ts repairTurn().
    lst = "\n".join(f"- line {d['line']}, col {d['col']}: {d['msg']}" for d in diags)
    return (
        "The previous script does not compile. Fix every error; change as little else as "
        f"possible.\n\nScript:\n\n{script}\nCompiler diagnostics:\n{lst}"
    )


def ask_message(text, ctx):
    return f"{text}\n\n{ctx}"


def lint_message(script, warnings):
    # askTurn(ask, currentScript) shape from generate.ts.
    lst = "\n".join(f"- {w}" for w in warnings)
    ask = (
        "Make this effect FASTER on the device while keeping the same look and the same "
        "uniforms. A static performance lint flagged these issues:\n"
        + lst
        + "\nReturn the complete revised program."
    )
    return f"Current script:\n\n{script}\nRequested change: {ask}"


# --------------------------------------------------------------------------- one run


def run_loop(model, sys_file, first_msg, workdir, fxc, rec):
    """First call + up to MAX_REPAIRS repair rounds (resumed in the same session)."""
    msg, resume, src, ok, diags = first_msg, None, None, False, []
    for rnd in range(MAX_REPAIRS + 1):
        r = call_claude(model, sys_file, msg, workdir, resume=resume)
        r["round"] = rnd
        r["kind"] = "ask" if rnd == 0 else "repair"
        rec["attempts"].append(r)
        if "error" in r:
            break
        resume = r.get("session_id")
        src = extract_program(r["text"])
        ok, diags, nbytes = compile_src(fxc, src)
        r["compile_ok"], r["diagnostics"], r["fxb_bytes"] = ok, diags, nbytes
        if ok:
            break
        msg = repair_message(src, diags)
    return src, ok


def run_one(job, ctx, fxc, force):
    variant, short, pid, ptext = job
    model = MODELS[short]
    name = f"{variant}__{short}__{pid}"
    meta_path = os.path.join(RUNS, name + ".json")
    if not force and os.path.exists(meta_path):
        return json.load(open(meta_path))
    sp = system_prompt(variant)
    workdir = tempfile.mkdtemp(prefix="fxgen-")
    sys_file = os.path.join(workdir, "system.txt")
    open(sys_file, "w").write(sp)
    rec = {
        "name": name,
        "variant": variant,
        "model": model,
        "model_short": short,
        "prompt_id": pid,
        "prompt": ptext,
        "system_prompt_sha256": hashlib.sha256(sp.encode()).hexdigest()[:16],
        "system_prompt_chars": len(sp),
        "attempts": [],
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    try:
        if variant == "app_lint":
            src, ok = run_lint_variant(short, pid, sys_file, workdir, fxc, rec)
        elif variant.endswith("_est"):
            src, ok = run_est_variant(variant, short, pid, sys_file, workdir, fxc, rec)
        else:
            src, ok = run_loop(model, sys_file, ask_message(ptext, ctx), workdir, fxc, rec)
    except subprocess.TimeoutExpired:
        src, ok = None, False
        rec["attempts"].append({"error": "timeout"})
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    rec["status"] = "ok" if ok else ("compile_error" if src else "no_reply")
    rec["n_calls"] = len(rec["attempts"])
    rec["total_cost_usd"] = round(sum((a.get("cost_usd") or 0) for a in rec["attempts"]), 4)
    rec["total_wall_s"] = round(sum((a.get("wall_s") or 0) for a in rec["attempts"]), 1)
    if src:
        prog = os.path.join(PROG_DIR, name + ".fx")
        hdr = (
            f"// fx_agent_eval: variant={variant} model={model} prompt={pid} status={rec['status']} "
            f"calls={rec['n_calls']}{' ' + rec['lint_outcome'] if 'lint_outcome' in rec else ''}"
            f"{' ' + rec['est_outcome'] if 'est_outcome' in rec else ''}\n"
            f"// request: {ptext}\n"
        )
        open(prog, "w").write(hdr + src)
        rec["program"] = os.path.relpath(prog, REPO)
    json.dump(rec, open(meta_path, "w"), indent=1)
    log(
        f"{name}: {rec['status']} calls={rec['n_calls']} {rec['total_wall_s']}s ${rec['total_cost_usd']}"
    )
    return rec


def run_lint_variant(short, pid, sys_file, workdir, fxc, rec):
    """Start from the `app` program for the same model/prompt; one lint-driven revision."""
    sys.path.insert(0, HERE)
    import analyze  # noqa: E402

    base = os.path.join(PROG_DIR, f"app__{short}__{pid}.fx")
    base_meta = json.load(open(os.path.join(RUNS, f"app__{short}__{pid}.json")))
    rec["base_program"] = os.path.relpath(base, REPO)
    if base_meta.get("status") != "ok":
        rec["lint_outcome"] = "base_not_compiling"
        return open(base).read().split("\n", 2)[2] if os.path.exists(base) else None, False
    base_src = open(base).read().split("\n", 2)[2]  # drop the 2-line provenance header
    warnings = analyze.lint_messages(base_src, fxc)
    rec["lint_warnings"] = warnings
    if not warnings:
        rec["lint_outcome"] = "no_lint_hits"
        return base_src, True
    src, ok = run_loop(MODELS[short], sys_file, lint_message(base_src, warnings), workdir, fxc, rec)
    if ok:
        rec["lint_outcome"] = "revised"
        return src, True
    rec["lint_outcome"] = "revision_failed_kept_original"
    return base_src, True


BUDGET_MS = 33.3
N_LEDS = 500


def estimate(fxc, src):
    """estimate_effect's view of a program: (frame ms, top findings, warnings)."""
    with tempfile.TemporaryDirectory() as d:
        sp, op = os.path.join(d, "e.fx"), os.path.join(d, "e.fxb")
        open(sp, "w").write(src)
        p = subprocess.run([fxc, sp, op], capture_output=True, text=True)
        if p.returncode != 0:
            return None
        warns = [
            {"line": int(a), "col": int(b), "msg": m}
            for a, b, m in re.findall(r"^warning: (\d+):(\d+): (.*)$", p.stderr, re.M)
        ]
        inp = os.path.join(d, "in.json")
        json.dump(
            [
                {
                    "name": "e",
                    "fxb": base64.b64encode(open(op, "rb").read()).decode(),
                    "source": src,
                    "warnings": warns,
                }
            ],
            open(inp, "w"),
        )
        q = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                os.path.join(HERE, "estimate.mjs"),
                str(N_LEDS),
                inp,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        r = json.loads(q.stdout)[0]
        return r["frameMs"], r["findings"], [f"line {w['line']}: {w['msg']}" for w in warns]


def est_message(script, ms, findings, warnings):
    # What an agent sees after estimate_effect on an over-budget effect.
    res = {"leds": N_LEDS, "estimate_ms": ms, "budget_ms": BUDGET_MS, "findings": findings}
    if warnings:
        res["warnings"] = warnings
    ask = (
        f"estimate_effect says this effect needs {ms} ms per frame on the {N_LEDS}-LED fixture, over the "
        f"{BUDGET_MS} ms budget:\n{json.dumps(res, indent=1)}\nMake it fit the budget while keeping the same "
        "look and the same uniforms. Return the complete revised program."
    )
    return f"Current script:\n\n{script}\nRequested change: {ask}"


def run_est_variant(variant, short, pid, sys_file, workdir, fxc, rec):
    """The `*2` program, then one estimate+findings revision if it is over budget."""
    base_v = variant[: -len("_est")]
    base = os.path.join(PROG_DIR, f"{base_v}__{short}__{pid}.fx")
    base_meta = json.load(open(os.path.join(RUNS, f"{base_v}__{short}__{pid}.json")))
    rec["base_program"] = os.path.relpath(base, REPO)
    if base_meta.get("status") != "ok":
        rec["est_outcome"] = "base_not_compiling"
        return open(base).read().split("\n", 2)[2] if os.path.exists(base) else None, False
    base_src = open(base).read().split("\n", 2)[2]
    est = estimate(fxc, base_src)
    rec["base_estimate"] = est
    if est is None or est[0] <= BUDGET_MS:
        rec["est_outcome"] = "within_budget"
        return base_src, True
    src, ok = run_loop(MODELS[short], sys_file, est_message(base_src, *est), workdir, fxc, rec)
    if ok:
        rec["est_outcome"] = "revised"
        return src, True
    rec["est_outcome"] = "revision_failed_kept_original"
    return base_src, True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="app,skill")
    ap.add_argument("--models", default="opus,sonnet")
    ap.add_argument(
        "--plan",
        default="",
        help="overrides --variants/--models: e.g. app=opus+sonnet,skill=opus+sonnet,app_perf=opus",
    )
    ap.add_argument("--prompts", default="", help="comma list of prompt ids (default all)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--fx-compile", default=os.environ.get("FX_COMPILE", DEFAULT_FXC))
    ap.add_argument(
        "--force", action="store_true", help="re-run even if out/runs/<name>.json exists"
    )
    a = ap.parse_args()
    if not os.path.exists(a.fx_compile):
        raise SystemExit(f"fx_compile not found at {a.fx_compile} (see README)")
    os.makedirs(RUNS, exist_ok=True)
    os.makedirs(PROG_DIR, exist_ok=True)
    P = json.load(open(os.path.join(HERE, "prompts.json")))
    want = set(filter(None, a.prompts.split(",")))
    if a.plan:
        plan = [(v, ms.split("+")) for v, ms in (x.split("=") for x in a.plan.split(","))]
    else:
        plan = [(v, a.models.split(",")) for v in a.variants.split(",")]
    jobs = [
        (v, m, p["id"], p["text"])
        for v, ms in plan
        for m in ms
        for p in P["prompts"]
        if not want or p["id"] in want
    ]
    for v, _ in plan:
        system_prompt(v)  # render once up front (fails fast)
    with cf.ThreadPoolExecutor(max_workers=min(4, a.jobs)) as ex:
        futs = [ex.submit(run_one, j, P["fixture_context"], a.fx_compile, a.force) for j in jobs]
        res = [f.result() for f in futs]
    by = {}
    for r in res:
        k = (r["variant"], r["model_short"])
        s = by.setdefault(k, {"n": 0, "ok": 0, "calls": 0})
        s["n"] += 1
        s["ok"] += r["status"] == "ok"
        s["calls"] += r["n_calls"]
    for (v, m), s in sorted(by.items()):
        log(f"{v:9s} {m:7s} ok {s['ok']}/{s['n']}  calls {s['calls']}")


if __name__ == "__main__":
    main()
