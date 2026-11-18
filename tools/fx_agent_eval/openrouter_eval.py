#!/usr/bin/env python3
"""Free-tier model eval (docs/design/ai-tiers.md): run the in-app effect AI's
chat prompt + tools against OpenRouter `:free` models, compile what they write
with the host fx_compile, and record tool-call validity, compile success and
latency.

What it exercises (same as the app's free tier):
  system = CHAT_SYSTEM (web/src/effects/ai/chatPrompt.ts, rendered from this tree)
  tools  = selectTools({tools: true, vision: false}, {perf: false, midi: false})
           i.e. set_script only (the free tier sends no images)
  user   = prompts.json request + its fixture context line
  loop   = the model must call set_script; its source is compiled; on a compile
           error the diagnostics go back as the tool result (like the app) and
           the model gets up to 2 repair rounds. A text-only reply (no tool
           call) is a tool-call failure; the round ends there.

Per cell it records: first-response tool-call validity (a set_script call with
JSON arguments carrying a non-empty `source`), compiled at round 1, compiled
within the repair budget, per-request latency, tokens, and every HTTP error
(429s included) with OpenRouter's error metadata.

It also probes, per model, whether the request still routes with
`provider.data_collection = "deny"` (only providers that don't collect data).

The key is read from a FILE at runtime (--key-file / OPENROUTER_KEY_FILE),
never printed, logged or written to the outputs. Requests are spaced
(--min-interval, default 3.5 s) to stay under the free 20 requests/minute.

Usage:
  OPENROUTER_KEY_FILE=/path/to/key python3 openrouter_eval.py \\
      --fx-compile /path/to/fx_compile \\
      --models nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free \\
      --prompts p01,p02,p03
Outputs: out/openrouter/runs/<model>__<pid>.json, out/openrouter/summary.{json,md}
Stdlib only.
"""
import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out", "openrouter")
RUNS = os.path.join(OUT, "runs")
API = "https://openrouter.ai/api/v1/chat/completions"
MAX_REPAIRS = 2
TIMEOUT_S = 120

DEFAULT_MODELS = [
    "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "inclusionai/ling-3.2-flash:free",
]


def render_chat_prompt():
    """CHAT_SYSTEM + the free tier's tool list, rendered from this tree with
    node --experimental-strip-types (node >= 22). Imports are flattened into a
    temp dir with explicit .ts specifiers."""
    files = {
        "chatPrompt.ts": "web/src/effects/ai/chatPrompt.ts",
        "system-prompt.ts": "web/src/effects/ai/system-prompt.ts",
        "lang-spec.ts": "web/src/effects/editor/lang-spec.ts",
        "bugReport.ts": "web/src/bugs/bugReport.ts",
    }
    rewrites = {
        '"../../bugs/bugReport"': '"./bugReport.ts"',
        '"./system-prompt"': '"./system-prompt.ts"',
        '"../editor/lang-spec"': '"./lang-spec.ts"',
    }
    d = tempfile.mkdtemp(prefix="orsp-")
    try:
        for name, rel in files.items():
            src = open(os.path.join(REPO, rel)).read()
            for a, b in rewrites.items():
                src = src.replace(a, b)
            # type-only import of ./provider is erased by strip-types, but keep
            # node from resolving it if a future edit makes it a value import.
            src = re.sub(r'^import type .* from "\./provider";\n', "", src, flags=re.M)
            open(os.path.join(d, name), "w").write(src)
        open(os.path.join(d, "render.mts"), "w").write(
            'import { CHAT_SYSTEM, selectTools } from "./chatPrompt.ts";\n'
            'import { writeFileSync } from "node:fs";\n'
            "writeFileSync(process.argv[2], JSON.stringify({ system: CHAT_SYSTEM, "
            "tools: selectTools({ tools: true, vision: false }, { perf: false, midi: false }) }));\n"
        )
        out = os.path.join(d, "out.json")
        subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", "render.mts", out],
            cwd=d,
            check=True,
            capture_output=True,
        )
        return json.load(open(out))
    finally:
        shutil.rmtree(d, ignore_errors=True)


DIAG = re.compile(r'line:\s*(\d+),\s*col:\s*(\d+),\s*msg:\s*"((?:[^"\\]|\\.)*)"')


def compile_src(fxc, src):
    with tempfile.TemporaryDirectory() as d:
        sp = os.path.join(d, "e.fx")
        open(sp, "w").write(src)
        p = subprocess.run([fxc, sp, os.path.join(d, "e.fxb")], capture_output=True, text=True)
        if p.returncode == 0:
            return True, []
        diags = [
            {"line": int(a), "col": int(b), "msg": m.encode().decode("unicode_escape")}
            for a, b, m in DIAG.findall(p.stderr)
        ]
        if not diags:
            diags = [{"line": 0, "col": 0, "msg": p.stderr.strip()[-500:] or f"rc={p.returncode}"}]
        return False, diags


def compile_result_text(ok, diags):
    if ok:
        return "Compiled OK. Device: NOT SENT (offline eval, no fixture connected)."
    lst = "\n".join(f"- line {d['line']}, col {d['col']}: {d['msg']}" for d in diags[:12])
    return f"Compile FAILED. Fix every error; change as little else as possible.\n{lst}"


def strip_fence(s):
    m = re.match(r"^\s*```[a-zA-Z]*\n(.*?)\n?```\s*$", s, re.S)
    return m.group(1) if m else s


class Client:
    def __init__(self, key, min_interval):
        self._key = key
        self.min_interval = min_interval
        self._last = 0.0

    def post(self, body):
        """POST one chat completion. Returns (status, json|None, seconds)."""
        wait = self._last + self.min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(
            API,
            data=json.dumps(body).encode(),
            headers={
                "authorization": f"Bearer {self._key}",
                "content-type": "application/json",
                "x-title": "Splanc free-tier eval",
            },
            method="POST",
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                data = json.loads(r.read().decode() or "null")
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                data = json.loads(e.read().decode() or "null")
            except Exception:
                data = None
            if data is not None:
                data["_retry_after"] = e.headers.get("retry-after")
                data["_ratelimit_reset"] = e.headers.get("x-ratelimit-reset")
        except Exception as e:  # timeout / network
            status, data = 0, {"error": {"message": f"{type(e).__name__}: {e}"[:300]}}
        dt = time.time() - t0
        self._last = time.time()
        return status, data, dt


REASONING = {
    # OpenRouter's normalized `reasoning` request field.
    "off": {"enabled": False},
    "low": {"effort": "low"},
    "default": None,
}


def one_cell(client, model, sysp, tools, ask, fxc, reasoning="off"):
    messages = [{"role": "system", "content": sysp}, {"role": "user", "content": ask}]
    rec = {"model": model, "requests": [], "first_tool_call_valid": False, "compiled_round": None}
    for rnd in range(MAX_REPAIRS + 1):
        body = {
            "model": model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": 4000,
            "temperature": 0.7,
        }
        if REASONING[reasoning] is not None:
            body["reasoning"] = REASONING[reasoning]
        status, data, dt = client.post(body)
        req = {"round": rnd, "status": status, "seconds": round(dt, 2)}
        if status != 200 or not data or not data.get("choices"):
            err = (data or {}).get("error") or {}
            req["error"] = {
                "code": err.get("code"),
                "message": str(err.get("message"))[:300],
                "metadata": err.get("metadata"),
                "retry_after": (data or {}).get("_retry_after"),
                "ratelimit_reset": (data or {}).get("_ratelimit_reset"),
            }
            rec["requests"].append(req)
            rec["outcome"] = "http_error"
            return rec
        ch = data["choices"][0]
        msg = ch.get("message") or {}
        req["finish_reason"] = ch.get("finish_reason")
        req["usage"] = data.get("usage")
        req["provider"] = data.get("provider")
        calls = msg.get("tool_calls") or []
        req["n_tool_calls"] = len(calls)
        req["text"] = (msg.get("content") or "")[:1500]
        src = None
        call_id = None
        for c in calls:
            fn = c.get("function") or {}
            if fn.get("name") != "set_script":
                continue
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                req["bad_arguments"] = (fn.get("arguments") or "")[:500]
                continue
            if (
                isinstance(args, dict)
                and isinstance(args.get("source"), str)
                and args["source"].strip()
            ):
                src = strip_fence(args["source"])
                call_id = c.get("id") or f"call_{rnd}"
                break
        if rnd == 0:
            rec["first_tool_call_valid"] = src is not None
        if src is None:
            rec["requests"].append(req)
            rec["outcome"] = "no_tool_call"
            return rec
        ok, diags = compile_src(fxc, src)
        req["compiled"] = ok
        req["diagnostics"] = diags[:6]
        req["source"] = src
        rec["requests"].append(req)
        if ok:
            rec["compiled_round"] = rnd
            rec["outcome"] = "compiled"
            return rec
        messages.append(
            {
                "role": "assistant",
                "content": msg.get("content") or "",
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": "set_script",
                            "arguments": json.dumps({"summary": "x", "source": src}),
                        },
                    }
                ],
            }
        )
        messages.append(
            {"role": "tool", "tool_call_id": call_id, "content": compile_result_text(ok, diags)}
        )
    rec["outcome"] = "compile_failed"
    return rec


def probe_deny(client, model):
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
        "max_tokens": 16,
        "provider": {"data_collection": "deny"},
    }
    status, data, dt = client.post(body)
    err = (data or {}).get("error") or {}
    return {
        "status": status,
        "seconds": round(dt, 2),
        "message": str(err.get("message") or "")[:200],
    }


def summarize(models, pids, tag=""):
    rows = []
    for m in models:
        cells = []
        for pid in pids:
            p = os.path.join(RUNS, f"{safe(m)}{tag}__{pid}.json")
            if os.path.exists(p):
                cells.append(json.load(open(p)))
        if not cells:
            continue
        reqs = [r for c in cells for r in c["requests"]]
        ok_lat = [r["seconds"] for r in reqs if r["status"] == 200]
        turn_lat = [
            sum(r["seconds"] for r in c["requests"])
            for c in cells
            if c.get("outcome") == "compiled"
        ]
        deny = None
        dp = os.path.join(RUNS, f"{safe(m)}__deny.json")
        if os.path.exists(dp):
            deny = json.load(open(dp))
        rows.append(
            {
                "model": m + tag,
                "n": len(cells),
                "http_errors": sum(1 for c in cells if c.get("outcome") == "http_error"),
                "n_429": sum(1 for r in reqs if r["status"] == 429),
                "tool_call_valid_first": sum(1 for c in cells if c["first_tool_call_valid"]),
                "compiled_round0": sum(1 for c in cells if c.get("compiled_round") == 0),
                "compiled_any": sum(1 for c in cells if c.get("compiled_round") is not None),
                "median_request_s": round(statistics.median(ok_lat), 1) if ok_lat else None,
                "median_turn_s_compiled": (
                    round(statistics.median(turn_lat), 1) if turn_lat else None
                ),
                "requests": len(reqs),
                "deny_probe": deny,
            }
        )
    json.dump(rows, open(os.path.join(OUT, f"summary{tag}.json"), "w"), indent=1)
    lines = [
        "# Free-tier (OpenRouter :free) authoring eval",
        "",
        "Generated by openrouter_eval.py (see its docstring). `n` = prompts run; an",
        "HTTP-error cell (e.g. 429) is counted in `n` and as a failure. Latency is",
        "wall time per request from this container; turn = all requests until compile.",
        "",
        "| model | n | valid set_script 1st reply | compiled 1st try | compiled ≤2 repairs | HTTP-error cells "
        "| 429s | median s/request | median s/turn (compiled) | data_collection=deny |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        d = r["deny_probe"]
        dtxt = (
            "n/a"
            if d is None
            else ("routes" if d["status"] == 200 else f"{d['status']}: {d['message'][:60]}")
        )
        lines.append(
            f"| {r['model']} | {r['n']} | {r['tool_call_valid_first']}/{r['n']} | {r['compiled_round0']}/{r['n']} | "
            f"{r['compiled_any']}/{r['n']} | {r['http_errors']} | {r['n_429']} | {r['median_request_s']} | "
            f"{r['median_turn_s_compiled']} | {dtxt} |"
        )
    open(os.path.join(OUT, f"summary{tag}.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


def safe(s):
    return re.sub(r"[^a-z0-9_.-]", "_", s.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-file", default=os.environ.get("OPENROUTER_KEY_FILE"))
    ap.add_argument(
        "--fx-compile",
        default=os.environ.get("FX_COMPILE", os.path.expanduser("~/perf/fx_compile")),
    )
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    ap.add_argument("--prompts", default="")
    ap.add_argument("--min-interval", type=float, default=3.5)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--reasoning", choices=sorted(REASONING), default="off")
    ap.add_argument("--tag", default="", help="suffix for run files (e.g. a reasoning variant)")
    ap.add_argument("--summary-only", action="store_true")
    a = ap.parse_args()

    models = [m for m in a.models.split(",") if m]
    pj = json.load(open(os.path.join(HERE, "prompts.json")))
    prompts = pj["prompts"]
    if a.prompts:
        want = set(a.prompts.split(","))
        prompts = [p for p in prompts if p["id"] in want]
    pids = [p["id"] for p in prompts]
    os.makedirs(RUNS, exist_ok=True)
    if a.summary_only:
        summarize(models, pids, a.tag)
        return
    if not a.key_file or not os.path.exists(a.key_file):
        sys.exit("need --key-file / OPENROUTER_KEY_FILE")
    if any(not m.endswith(":free") for m in models):
        sys.exit("refusing non-:free model ids (the eval is for the free tier)")
    key = open(a.key_file).read().strip()
    client = Client(key, a.min_interval)
    del key
    rendered = render_chat_prompt()
    tools = [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in rendered["tools"]
    ]
    open(os.path.join(OUT, "system.txt"), "w").write(rendered["system"])
    for m in models:
        dp = os.path.join(RUNS, f"{safe(m)}__deny.json")
        if a.force or not os.path.exists(dp):
            json.dump(probe_deny(client, m), open(dp, "w"), indent=1)
        for p in prompts:
            out = os.path.join(RUNS, f"{safe(m)}{a.tag}__{p['id']}.json")
            if os.path.exists(out) and not a.force:
                continue
            ask = f"{p['text']}\n\n{pj['fixture_context']}"
            rec = one_cell(client, m, rendered["system"], tools, ask, a.fx_compile, a.reasoning)
            rec["prompt"] = p["id"]
            rec["reasoning"] = a.reasoning
            json.dump(rec, open(out, "w"), indent=1)
            print(
                m, p["id"], rec.get("outcome"), [r["status"] for r in rec["requests"]], flush=True
            )
    summarize(models, pids, a.tag)


if __name__ == "__main__":
    main()
