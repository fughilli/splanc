#!/usr/bin/env python3
"""Static performance analysis + perf lint for FX effect programs.

For each program (source + `fx_compile --disasm`):
  * per-LED op counts (shade + the user functions it calls, loops walked by their
    constant trip counts; all branch arms counted = upper bound) and per-frame
    counts (update), split into float arithmetic, float transcendental/heavy
    builtins by name, int/fixed ops, conversions, and plumbing;
  * a rough cycle estimate from the measured C6 costs (COST below);
  * a variance analysis: abstract interpretation of the operand stack + locals
    over the shade CFG, classifying every value as const / frame (time, dt,
    frame, uniforms, state) / led (led.* only) / dynamic, with control taint from
    branch conditions. Ops whose result is const/frame are hoistable to update();
    led-only ops are memoizable per LED (cache in a buffer once);
  * perf-lint rules with source lines where a cheaper equivalent exists.

Usage:
  analyze.py [--fx-compile PATH] [--out-dir DIR] [files or dirs ...]
    default input: firmware/fx_perf_bench/agent/*.fx
    writes <out-dir>/analysis.json and <out-dir>/summary.md (default tools/fx_agent_eval/out)
Stdlib only. Also importable: lint_messages(src, fxc) -> [str] (used by gen.py app_lint).
"""
import argparse
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_FXC = os.path.expanduser("~/perf/fx_compile")
N_LEDS = 500
FRAME_CYCLES_PER_LED = 10_000  # 33 ms * 160 MHz / 500 LEDs ~= 10.6k
FIRMWARE_FRAMING = 2_300

# ----------------------------------------------------------------------------- disasm

OPLINE = re.compile(r"^\s*(\d+): (\S+)(.*)$")
KV = re.compile(r"(\w+)=(-?\w+)")


def parse_disasm(text):
    consts, ops = [], []
    upd = shd = None
    for line in text.splitlines():
        m = re.match(r";\s+\[(\d+)\] = (\S+) \(i32 (-?\d+)\)", line)
        if m:
            consts.append(
                (
                    float(m.group(2)) if m.group(2) not in ("NaN", "inf", "-inf") else 0.0,
                    int(m.group(3)),
                )
            )
            continue
        m = re.match(r"; update_entry=(\S+)\s+shade_entry=(\S+)", line)
        if m:
            upd = None if m.group(1) == "none" else int(m.group(1))
            shd = None if m.group(2) == "none" else int(m.group(2))
            continue
        m = OPLINE.match(line)
        if not m:
            continue
        pc, name, rest = int(m.group(1)), m.group(2), m.group(3).strip()
        a = {k: v for k, v in KV.findall(rest)}
        op = {"pc": pc, "op": name, "rest": rest}
        for k, v in a.items():
            try:
                op[k] = int(v)
            except ValueError:
                op[k] = v
        t = re.search(r"-> (\d+)", rest)
        if t:
            op["target"] = int(t.group(1))
        c = re.match(r"c(\d+)$", rest) or re.search(r"\bc(\d+)$", rest)
        if c:
            op["const"] = int(c.group(1))
        parts = rest.split()
        if (
            name
            in (
                "UN_MATH",
                "BIN_MATH",
                "LOAD_CTX",
                "LOAD_CTX_FIX",
                "CMP",
                "CMP_I",
                "LOGIC",
                "GRAPH_QUERY",
                "BR_CMP_I",
            )
            and parts
        ):
            op["fn"] = parts[0]
        if name == "SWIZZLE":
            op["comps"] = [
                int(x) for x in re.search(r"\[([\d,]*)\]", rest).group(1).split(",") if x
            ]
        ops.append(op)
    return {
        "consts": consts,
        "ops": ops,
        "update": upd,
        "shade": shd,
        "by_pc": {o["pc"]: i for i, o in enumerate(ops)},
    }


# ----------------------------------------------------------------------------- op model

CTX_W = {
    "led.pos": 3,
    "led.uv": 2,
    "imu.accel": 3,
    "imu.gyro": 3,
    "led.room": 3,
    "room.min": 3,
    "room.max": 3,
}
FRAME_CTX = {"time", "dt", "frame", "imu.accel", "imu.gyro", "room.min", "room.max"}
DYN_CTX = {"led.dist"}  # re-rooted by flood_from() in update -> led AND frame

UN_HEAVY = {"sin", "cos", "tan", "sqrt", "exp", "log"}
BIN_HEAVY = {"pow", "atan2"}
FLOAT_ARITH = {"ADD", "SUB", "MUL", "DIV", "NEG", "SCALE"}
FLOAT_VEC = {"CLAMP", "MIX", "DOT", "CROSS", "CMP", "LOGIC"}
HEAVY_OPS = {
    "LENGTH": "length",
    "NORMALIZE": "normalize",
    "DISTANCE": "distance",
    "SMOOTHSTEP": "smoothstep",
    "HSV2RGB": "hsv2rgb",
    "PALETTE": "palette",
    "HASH1": "hash",
    "HASH3": "hash",
}
FIX_NAMED = {
    "SIN_FIX": "sin",
    "COS_FIX": "cos",
    "EXP_FIX": "exp",
    "SQRT_FIX": "sqrt",
    "LENGTH_FIX": "length",
    "DISTANCE_FIX": "distance",
    "NORMALIZE_FIX": "normalize",
    "SMOOTHSTEP_FIX": "smoothstep",
    "HSV2RGB_FIX": "hsv2rgb",
    "PALETTE_FIX": "palette",
    "ATAN2_FIX": "atan2",
    "LOG_FIX": "log",
    "TAN_FIX": "tan",
    "POW_FIX": "pow",
    "HASH_FIX": "hash",
    "HASH3_FIX": "hash",
}
CONVERSIONS = {
    "I2F",
    "F2I",
    "FIX2F",
    "F2FIX",
    "I2FIX",
    "FIX2I",
    "FIX_TO_F",
    "FIX_FROM_F",
    "FIX_RESCALE",
}
PLUMBING = {
    "PUSH_CONST",
    "LOAD_UNIFORM",
    "LOAD_STATE",
    "STORE_STATE",
    "LOAD_LOCAL",
    "STORE_LOCAL",
    "TEE_LOCAL",
    "FILL_LOCAL",
    "LOAD_CTX",
    "SWIZZLE",
    "SWAP",
    "POP",
    "RET",
    "RET_FN",
    "CALL",
    "BR_FALSE",
    "JMP",
    "BR_CMP_I",
    "INC_LOCAL_I",
    "LOAD_STATE_IDX",
    "STORE_STATE_IDX",
    "LOAD_LOCAL_IDX",
    "STORE_LOCAL_IDX",
    "LOAD_BUF",
    "STORE_BUF",
    "SAMPLE_TEX",
    "PAINT_TEX",
    "GRAPH_QUERY",
    "FLOOD_FROM",
    "RET_RGB8",
    "RET_RGB_FIX",
    "JIT_CALL",
}
NON_COMPUTE = PLUMBING  # LOAD_CTX_FIX is an int/fixed op (it converts in firmware)


def heavy_name(o):
    """Builtin name for a float transcendental/heavy op, else None."""
    n = o["op"]
    if n == "UN_MATH" and o.get("fn") in UN_HEAVY:
        return o["fn"]
    if n == "BIN_MATH" and o.get("fn") in BIN_HEAVY:
        return o["fn"]
    return HEAVY_OPS.get(n)


def builtin_name(o):
    """Source builtin an op came from (float or fixed), for source-line mapping."""
    return heavy_name(o) or FIX_NAMED.get(o["op"])


def category(o):
    n = o["op"]
    if heavy_name(o):
        return "float_heavy"
    if n in FLOAT_ARITH:
        return "float_arith"
    if n in ("UN_MATH", "BIN_MATH") or n in FLOAT_VEC:
        return "float_misc"
    if n in CONVERSIONS:
        return "conversion"
    if n in PLUMBING:
        return "plumbing"
    return "int_fixed"


def cost(o):
    """Rough cycles incl. ~70 dispatch, from the measured C6 numbers (see README)."""
    n = o["op"]
    k = o.get("n", 1) or 1
    fn = o.get("fn")
    D = 70
    if n in ("ADD", "SUB", "MUL", "SCALE"):
        return D + 110 * k
    if n == "DIV":
        return D + 220 * k
    if n == "NEG":
        return D + 10 * k
    if n == "UN_MATH":
        return {"sin": 570, "cos": 570, "tan": 1200, "sqrt": 680, "exp": 700, "log": 700}.get(
            fn, D + 80
        ) * k
    if n == "BIN_MATH":
        return {"pow": 1800, "atan2": 1040}.get(fn, D + (350 if fn == "mod" else 60)) * k
    table = {
        "CLAMP": D + 100 * k,
        "MIX": D + 250 * k,
        "SMOOTHSTEP": 1000 * k,
        "DOT": D + 220 * k,
        "CROSS": D + 700,
        "LENGTH": 700 + 120 * k,
        "DISTANCE": 800 + 180 * k,
        "NORMALIZE": 1000 + 250 * k,
        "HSV2RGB": 1400,
        "PALETTE": 800,
        "HASH1": 250,
        "HASH3": 400,
        "CMP": 120,
        "LOGIC": 80,
        "SIN_FIX": 150,
        "COS_FIX": 150,
        "EXP_FIX": 150,
        "HSV2RGB_FIX": 300,
        "PALETTE_FIX": 250,
        "SQRT_FIX": 250,
        "ATAN2_FIX": 300,
        "POW_FIX": 400,
        "LOG_FIX": 250,
        "TAN_FIX": 250,
        "HASH_FIX": 120,
        "HASH3_FIX": 150,
        "LOAD_BUF": 120,
        "STORE_BUF": 120,
        "SAMPLE_TEX": 1500,
        "PAINT_TEX": 400,
        "CALL": 80,
        "RET_FN": 80,
        "FLOOD_FROM": 5000,
    }
    if n in table:
        return table[n]
    if n in CONVERSIONS:
        return 120
    if n.endswith("_FIX") and k > 1:
        return 90 + 40 * k
    return D + 5 * (k if n in PLUMBING else 4)


# ----------------------------------------------------------------------------- variance lattice

C, F, L, Dy = 0, 1, 2, 3
CLS = ["const", "frame", "led", "dynamic"]


def J(a, b):
    if a == b:
        return a
    if {a, b} == {F, L}:
        return Dy
    return max(a, b)


def Jall(xs, init=C):
    r = init
    for x in xs:
        r = J(r, x)
    return r


class Prog:
    def __init__(self, src, dis):
        self.src = src
        self.d = dis
        self.ops = dis["ops"]
        self.by_pc = dis["by_pc"]
        # buffer/texture element widths by declaration order (shared id space)
        self.buf_w = []
        for m in re.finditer(r"\b(buffer|texture)\s+(\w+)\s+(\w+)", strip_comments(src)):
            self.buf_w.append(
                {
                    "float": 1,
                    "int": 1,
                    "fixed": 1,
                    "fixed16": 1,
                    "fixed8": 1,
                    "vec2": 2,
                    "vec3": 3,
                    "vec4": 4,
                }.get(m.group(2), 1)
            )
        self.calls = {}  # target -> set of call-site pcs
        for o in self.ops:
            if o["op"] == "CALL":
                self.calls.setdefault(o["target"], set()).add(o["pc"])
        entries = sorted(
            set([e for e in (dis["update"], dis["shade"]) if e is not None]) | set(self.calls)
        )
        self.entries = entries

    def idx(self, pc):
        return self.by_pc.get(pc)

    def next_pc(self, i):
        return self.ops[i + 1]["pc"] if i + 1 < len(self.ops) else None

    def region(self, entry):
        """op indices from entry to the next entry point (functions are contiguous)."""
        later = [e for e in self.entries if e > entry]
        end = later[0] if later else 1 << 30
        i = self.idx(entry)
        out = []
        while i is not None and i < len(self.ops) and self.ops[i]["pc"] < end:
            out.append(i)
            i += 1
        return out

    def bufw(self, oid):
        return self.buf_w[oid] if oid < len(self.buf_w) else 1

    # --- stack effects ---------------------------------------------------
    def effect(self, o):
        """(pops, pushes) in slots."""
        n, k = o["op"], o.get("n", 1)
        if n == "PUSH_CONST":
            return 0, 1
        if n in ("LOAD_UNIFORM", "LOAD_STATE", "LOAD_LOCAL"):
            return 0, k
        if n in ("STORE_STATE", "STORE_LOCAL"):
            return k, 0
        if n == "TEE_LOCAL":
            return k, k
        if n in ("FILL_LOCAL", "INC_LOCAL_I", "JMP", "CALL", "RET_FN", "JIT_CALL"):
            return 0, 0
        if n == "LOAD_CTX":
            return 0, CTX_W.get(o.get("fn"), 1)
        if n in ("ADD", "SUB", "MUL", "DIV", "BIN_MATH"):
            return 2 * k, k
        if n in ("NEG", "UN_MATH", "NORMALIZE"):
            return k, k
        if n == "SCALE":
            return k + 1, k
        if n in ("CLAMP", "SMOOTHSTEP"):
            return 3 * k, k
        if n == "MIX":
            return 2 * k + 1, k
        if n in ("DOT", "DISTANCE"):
            return 2 * k, 1
        if n == "LENGTH":
            return k, 1
        if n in ("CROSS", "CROSS_FIX"):
            return 6, 3
        if n == "SWIZZLE":
            return o["src"], o["dst"]
        if n in (
            "CMP",
            "CMP_I",
            "MUL_FIX",
            "DIV_FIX",
            "MUL_FIX_N",
            "DIV_FIX_N",
            "ADD_I",
            "SUB_I",
            "MUL_I",
            "DIV_I",
            "MOD_I",
            "MIN_I",
            "MAX_I",
            "STEP_I",
            "ATAN2_FIX",
            "POW_FIX",
        ):
            return 2, 1
        if n == "LOGIC":
            return (1, 1) if o.get("fn") == "not" else (2, 1)
        if n == "BR_FALSE":
            return 1, 0
        if n == "BR_CMP_I":
            return 2, 0
        if n in ("HASH1", "HASH_FIX"):
            return 1, 1
        if n in ("HASH3", "HASH3_FIX"):
            return 3, 1
        if n in ("HSV2RGB", "HSV2RGB_FIX"):
            return 3, 3
        if n in ("PALETTE", "PALETTE_FIX"):
            return 1, 3
        if n in ("POP", "RET"):
            return k, 0
        if n in ("RET_RGB8", "RET_RGB_FIX"):
            return 3, 0
        if n == "SWAP":
            return o["a"] + o["b"], o["a"] + o["b"]
        if (
            n
            in (
                "NEG_I",
                "ABS_I",
                "SIGN_I",
                "FLOOR_FIX",
                "CEIL_FIX",
                "FRACT_FIX",
                "SQRT_FIX",
                "SIN_FIX",
                "COS_FIX",
                "EXP_FIX",
                "LOG_FIX",
                "TAN_FIX",
            )
            or n in CONVERSIONS
        ):
            return 1, 1
        if n in ("CLAMP_I", "MIX_FIX"):
            return 3, 1
        if n in ("LOAD_STATE_IDX", "LOAD_LOCAL_IDX"):
            return 1, k
        if n in ("STORE_STATE_IDX", "STORE_LOCAL_IDX"):
            return k + 1, 0
        if n == "GRAPH_QUERY":
            f = o.get("fn")
            return (
                {
                    "seg_len": 1,
                    "node_deg": 1,
                    "term": 1,
                    "seg_node": 2,
                    "node_seg": 2,
                    "node_side": 2,
                }.get(f, 0),
                1,
            )
        if n == "LOAD_BUF":
            return 1, self.bufw(o["id"])
        if n == "STORE_BUF":
            return self.bufw(o["id"]) + 1, 0
        if n == "SAMPLE_TEX":
            return 2, self.bufw(o["id"])
        if n == "PAINT_TEX":
            return self.bufw(o["id"]) + 2, 0
        if n == "FLOOD_FROM":
            return 1, 0
        if n == "LOAD_CTX_FIX":
            return 0, 1
        if n == "SCALE_FIX":
            return k + 1, k
        if n == "DOT_FIX" or n == "DISTANCE_FIX":
            return 2 * k, 1
        if n == "LENGTH_FIX":
            return k, 1
        if n == "NORMALIZE_FIX":
            return k, k
        if n in ("SMOOTHSTEP_FIX", "CLAMP_V_FIX"):
            return 3 * k, k
        if n == "MIX_V_FIX":
            return 2 * k + 1, k
        if n == "I2C_WRITE":
            return 2, 0
        if n == "I2C_READ":
            return 1, 1
        raise ValueError(f"unknown op {n}")

    # --- abstract interpretation ---------------------------------------
    def analyze_entry(self, entry, ctrl):
        """Worklist abstract interpretation from `entry` (update or shade).
        Returns per-pc {res: class, args: [classes]} for every op reached (incl. callees)."""
        rec = {}
        cond = {}  # branch pc -> condition class
        self._interp(entry, (), {}, rec, cond, ctrl, depth=0)
        return rec, cond

    def _interp(self, entry, stack, locs, rec, cond, ctrl, depth):
        """Interpret a function (or entry) region; returns joined exit (stack, locals)."""
        if depth > 16:
            return stack, locs
        states = {entry: (stack, dict(locs))}
        work = [entry]
        exit_state = None
        iters = 0
        while work and iters < 20000:
            iters += 1
            pc = work.pop()
            i = self.idx(pc)
            if i is None:
                continue
            st, lc = states[pc]
            st = list(st)
            lc = dict(lc)
            o = self.ops[i]
            n = o["op"]
            pops, pushes = self.effect(o)
            if len(st) < pops:  # malformed/unknown: pad
                st = [C] * (pops - len(st)) + st
            args = st[len(st) - pops :] if pops else []
            base = st[: len(st) - pops] if pops else st
            ct = ctrl.get(pc, C)
            out = None
            succ = [self.next_pc(i)]
            if n == "PUSH_CONST":
                out = [C]
            elif n in ("LOAD_UNIFORM", "LOAD_STATE"):
                out = [F] * pushes
            elif n == "LOAD_LOCAL":
                out = [lc.get(o["slot"] + j, C) for j in range(pushes)]
            elif n in ("STORE_LOCAL", "TEE_LOCAL"):
                for j in range(o["n"]):
                    lc[o["slot"] + j] = J(args[j], ct)
                out = list(args) if n == "TEE_LOCAL" else []
            elif n == "FILL_LOCAL":
                for j in range(o["n"]):
                    lc[o["slot"] + j] = J(C, ct)
                out = []
            elif n == "INC_LOCAL_I":
                lc[o["slot"]] = J(lc.get(o["slot"], C), ct)
                out = []
            elif n in ("LOAD_LOCAL_IDX",):
                out = [
                    Jall(
                        args
                        + [
                            lc.get(s, C)
                            for s in range(o["base"], o["base"] + o["stride"] * o["count"])
                        ]
                    )
                ] * pushes
            elif n == "STORE_LOCAL_IDX":
                v = J(Jall(args), ct)
                for s in range(
                    o["base"] + o["off"], o["base"] + o["stride"] * o["count"], o["stride"]
                ):
                    for j in range(o["n"]):
                        lc[s + j] = J(lc.get(s + j, C), v)
                out = []
            elif n == "LOAD_STATE_IDX":
                out = [J(F, Jall(args))] * pushes
            elif n in ("LOAD_CTX", "LOAD_CTX_FIX"):
                f = o.get("fn")
                c = F if f in FRAME_CTX else (Dy if f in DYN_CTX else L)
                out = [c] * pushes
            elif n in ("LOAD_BUF", "SAMPLE_TEX"):
                out = [Dy] * pushes  # buffers/textures are mutable state
            elif n == "SWIZZLE":
                out = [args[c] if c < len(args) else C for c in o["comps"]]
            elif n == "SWAP":
                a = o["a"]
                out = args[a:] + args[:a]
            elif n == "BR_FALSE" or n == "BR_CMP_I":
                cond[pc] = J(cond.get(pc, C), Jall(args))
                succ = [self.next_pc(i), o["target"]]
                out = []
            elif n == "JMP":
                succ = [o["target"]]
                out = []
            elif n == "CALL":
                rst, rlc = self._interp(o["target"], tuple(st), lc, rec, cond, ctrl, depth + 1)
                st2, lc = list(rst), dict(rlc)
                rec.setdefault(pc, {"res": C, "args": []})
                nxt = self.next_pc(i)
                self._merge(states, work, nxt, st2, lc)
                continue
            elif n in ("RET_FN", "RET", "RET_RGB8", "RET_RGB_FIX"):
                r = rec.setdefault(pc, {"res": C, "args": []})
                r["args"] = (
                    [J(a, b) for a, b in zip(r["args"] + [C] * len(args), args)]
                    if r["args"]
                    else list(args)
                )
                if n == "RET_FN":
                    ex = (tuple(st), lc)
                    exit_state = ex if exit_state is None else self._join_state(exit_state, ex)
                continue
            elif pushes == 0:
                out = []
            else:
                out = [Jall(args)] * pushes
            # record
            r = rec.setdefault(pc, {"res": C, "args": [C] * len(args)})
            if out:
                r["res"] = J(r["res"], Jall(out))
            if len(r["args"]) == len(args):
                r["args"] = [J(a, b) for a, b in zip(r["args"], args)]
            st = list(base) + list(out)
            for s in succ:
                if s is not None:
                    self._merge(states, work, s, st, lc)
        return exit_state if exit_state is not None else (tuple(stack), locs)

    @staticmethod
    def _join_state(a, b):
        sa, la = a
        sb, lb = b
        if len(sa) != len(sb):
            m = min(len(sa), len(sb))
            sa, sb = sa[len(sa) - m :], sb[len(sb) - m :]
        st = tuple(J(x, y) for x, y in zip(sa, sb))
        lc = dict(la)
        for k, v in lb.items():
            lc[k] = J(lc.get(k, C), v)
        return st, lc

    def _merge(self, states, work, pc, st, lc):
        new = (tuple(st), dict(lc))
        if pc not in states:
            states[pc] = new
            work.append(pc)
            return
        j = self._join_state(states[pc], new)
        if j != states[pc]:
            states[pc] = j
            work.append(pc)

    def ctrl_regions(self, cond):
        """pc -> control-taint class from enclosing data-dependent branches."""
        ctrl = defaultdict(int)
        pcs = [o["pc"] for o in self.ops]
        for bpc, c in cond.items():
            if c == C:
                continue
            o = self.ops[self.idx(bpc)]
            t = o["target"]
            if t <= bpc:
                continue
            regions = [(bpc + 1, t)]
            ti = self.idx(t)
            if ti and ti > 0 and self.ops[ti - 1]["op"] == "JMP" and self.ops[ti - 1]["target"] > t:
                regions.append((t, self.ops[ti - 1]["target"]))
            for a, b in regions:
                for p in pcs:
                    if a <= p < b:
                        ctrl[p] = J(ctrl[p], c)
        return dict(ctrl)

    def variance(self, entry):
        ctrl = {}
        rec = cond = None
        for _ in range(4):
            rec, cond = self.analyze_entry(entry, ctrl)
            nctrl = self.ctrl_regions(cond)
            if nctrl == ctrl:
                break
            ctrl = nctrl
        return rec, cond

    def once_regions(self, cond):
        """pcs inside `if (<frame-only condition>) { ... buf[i] = ... }` — the first-frame
        cache-fill idiom. Not counted per LED (it runs once, not every frame)."""
        once = set()
        for bpc, c in cond.items():
            o = self.ops[self.idx(bpc)]
            if c != F or o["op"] != "BR_FALSE" or o["target"] <= bpc:
                continue
            body = [x for x in self.ops if bpc < x["pc"] < o["target"]]
            if any(x["op"] in ("STORE_BUF", "PAINT_TEX") for x in body):
                once |= {x["pc"] for x in body}
        return once

    # --- loops + execution counts --------------------------------------
    def loops(self, entry):
        """[(head_pc, back_pc, trips, known)] for back-edges in the region."""
        out = []
        consts = self.d["consts"]
        for i in self.region(entry):
            o = self.ops[i]
            if o["op"] == "JMP" and o["target"] < o["pc"]:
                h = self.idx(o["target"])
                trips, known = 8, False
                # header: LOAD_LOCAL s ; PUSH_CONST cN ; BR_CMP_I lt|le
                try:
                    a, b, c = self.ops[h], self.ops[h + 1], self.ops[h + 2]
                    if (
                        a["op"] == "LOAD_LOCAL"
                        and b["op"] == "PUSH_CONST"
                        and c["op"] == "BR_CMP_I"
                    ):
                        slot, N = a["slot"], consts[b["const"]][1]
                        init, step = 0, 1
                        j = h - 1
                        if (
                            j >= 1
                            and self.ops[j]["op"] == "STORE_LOCAL"
                            and self.ops[j]["slot"] == slot
                            and self.ops[j - 1]["op"] == "PUSH_CONST"
                        ):
                            init = consts[self.ops[j - 1]["const"]][1]
                        p = self.ops[i - 1]
                        if p["op"] == "INC_LOCAL_I" and p["slot"] == slot:
                            step = consts[int(re.search(r"c(\d+)", p["rest"]).group(1))][1] or 1
                        span = N - init + (1 if c.get("fn") == "le" else 0)
                        if step > 0 and span >= 0:
                            trips, known = -(-span // step), True
                except (IndexError, KeyError, TypeError, AttributeError):
                    pass
                out.append((o["target"], o["pc"], trips, known))
        return out

    def exec_counts(self, entry, mult=1, acc=None, depth=0, loops_acc=None):
        """pc -> executions per invocation (loops walked, both branch arms counted)."""
        acc = acc if acc is not None else Counter()
        loops_acc = loops_acc if loops_acc is not None else []
        if depth > 16:
            return acc, loops_acc
        lps = self.loops(entry)
        for lp in lps:
            loops_acc.append(
                {
                    "entry": entry,
                    "head": lp[0],
                    "trips": lp[2],
                    "known": lp[3],
                    "outer_mult": mult,
                    "body_ops": 0,
                }
            )
        for i in self.region(entry):
            o = self.ops[i]
            m = mult
            for h, b, t, _ in lps:
                if h <= o["pc"] <= b:
                    m *= t
            acc[o["pc"]] += m
            if o["op"] == "CALL":
                self.exec_counts(o["target"], m, acc, depth + 1, loops_acc)
        return acc, loops_acc


# ----------------------------------------------------------------------------- source


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


FUNC_DEF = re.compile(r"^[ \t]*(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{", re.M)
KEYWORDS = {"if", "for", "while", "return", "else", "switch"}


def source_functions(src):
    """[{name, start_line, end_line, body}] for top-level function definitions (1-based lines)."""
    s = strip_comments(src)
    funcs = []
    for m in FUNC_DEF.finditer(s):
        if m.group(1) in KEYWORDS or m.group(2) in KEYWORDS:
            continue
        # top-level only: brace depth at m.start() == 0
        if s[: m.start()].count("{") != s[: m.start()].count("}"):
            continue
        i = m.end() - 1
        depth = 0
        for j in range(i, len(s)):
            if s[j] == "{":
                depth += 1
            elif s[j] == "}":
                depth -= 1
                if depth == 0:
                    break
        body = s[m.start() : j + 1]
        funcs.append(
            {
                "name": m.group(2),
                "start": s[: m.start()].count("\n") + 1,
                "end": s[:j].count("\n") + 1,
                "body": body,
                "start_off": m.start(),
            }
        )
    return funcs


def reachable_funcs(funcs, root):
    by = {f["name"]: f for f in funcs}
    seen, todo = set(), [root]
    while todo:
        n = todo.pop()
        if n in seen or n not in by:
            continue
        seen.add(n)
        body = by[n]["body"].split("{", 1)[1]
        for c in re.findall(r"\b(\w+)\s*\(", body):
            if c in by and c not in seen:
                todo.append(c)
    return seen


BUILTIN_SRC = {
    "sin",
    "cos",
    "tan",
    "sqrt",
    "exp",
    "log",
    "pow",
    "atan2",
    "length",
    "distance",
    "normalize",
    "smoothstep",
    "hsv2rgb",
    "palette",
    "hash",
}


def src_occurrences(src_lines_stripped, start, end):
    """name -> [line] occurrences of mapped builtins in textual order within [start, end]."""
    occ = defaultdict(list)
    for ln in range(start, end + 1):
        text = src_lines_stripped[ln - 1]
        for m in re.finditer(
            r"\b(sin|cos|tan|sqrt|exp|log|pow|atan2|length|distance|normalize|"
            r"smoothstep|hsv2rgb|palette[0-9]|hash)\s*\(",
            text,
        ):
            nm = m.group(1)
            nm = "palette" if nm.startswith("palette") else nm
            occ[nm].append(ln)
    return occ


# ----------------------------------------------------------------------------- analysis


def compile_disasm(fxc, src):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "e.fx")
        open(p, "w").write(src)
        r = subprocess.run([fxc, "--disasm", p], capture_output=True, text=True)
        if r.returncode != 0:
            return None, r.stderr.strip()
        return r.stdout, None


def analyze_source(src, fxc, name="<src>"):
    dis_text, err = compile_disasm(fxc, src)
    rec = {"name": name}
    if dis_text is None:
        rec["compile_ok"] = False
        rec["error"] = err[-400:]
        return rec
    rec["compile_ok"] = True
    dis = parse_disasm(dis_text)
    P = Prog(src, dis)
    S = strip_comments(src)
    lines = S.split("\n")
    funcs = source_functions(src)
    fixed_src = bool(re.search(r"\bfixed(8|16)?\b", S))
    fixed_ops = sum(
        1
        for o in P.ops
        if o["op"].endswith("_FIX") or "FIX" in o["op"] or o["op"] in ("MUL_FIX_N",)
    )
    rec["uses_fixed_type"] = fixed_src
    rec["fixed_ops_static"] = fixed_ops
    rec["buffers_textures"] = {
        "buffers": len(re.findall(r"\bbuffer\s+\w+", S)),
        "textures": len(re.findall(r"\btexture\s+\w+", S)),
    }
    rec["code_ops"] = len(P.ops)

    # map bytecode regions -> source functions (both in definition order)
    entry_regions = {}
    reach_all = set()
    for root in ("shade", "update"):
        reach_all |= reachable_funcs(funcs, root)
    src_in_code = [f for f in funcs if f["name"] in reach_all]
    if len(src_in_code) == len(P.entries):
        for f, e in zip(src_in_code, P.entries):
            entry_regions[e] = f
    shade_reach = reachable_funcs(funcs, "shade")

    out = {}
    once = set()
    if dis["shade"] is not None:
        var, shade_cond = P.variance(dis["shade"])
        once = P.once_regions(shade_cond)
    for ctxname, entry in (("per_led", dis["shade"]), ("per_frame", dis["update"])):
        if entry is None:
            out[ctxname] = None
            continue
        counts, loops = P.exec_counts(entry)
        if ctxname == "per_led":
            for pc in once:
                counts.pop(pc, None)
        cat = Counter()
        heavy = Counter()
        fixed_named = Counter()
        opc = Counter()
        cyc = 0
        for pc, m in counts.items():
            o = P.ops[P.idx(pc)]
            cat[category(o)] += m
            opc[o["op"]] += m
            cyc += cost(o) * m
            h = heavy_name(o)
            if h:
                heavy[h] += m
            if o["op"] in FIX_NAMED:
                fixed_named[FIX_NAMED[o["op"]]] += m
        trans = sum(v for k, v in heavy.items() if k != "hash")
        d = {
            "ops": sum(counts.values()),
            "by_category": dict(cat),
            "float_heavy_by_name": dict(heavy),
            "float_transcendentals": trans,
            "fixed_builtins_by_name": dict(fixed_named),
            "est_cycles": int(cyc),
            "opcodes": dict(opc.most_common(12)),
        }
        if ctxname == "per_led":
            d["loops"] = [{"trips": lp["trips"], "known_trip_count": lp["known"]} for lp in loops]
            d["cache_fill_ops_excluded"] = len(once)
            d["user_calls"] = sum(m for pc, m in counts.items() if P.ops[P.idx(pc)]["op"] == "CALL")
            d["est_frame_ms_500"] = round((cyc + FIRMWARE_FRAMING) * N_LEDS / 160e6 * 1000, 1)
        out[ctxname] = d
        if ctxname == "per_led":
            shade_counts = counts
            shade_loops = loops
    rec.update(out)

    # variance
    if dis["shade"] is not None:
        vc = Counter()
        vcyc = Counter()
        heavy_ops_cls = []
        for pc, m in shade_counts.items():
            o = P.ops[P.idx(pc)]
            if o["op"] in NON_COMPUTE or pc not in var:
                continue
            c = var[pc]["res"]
            vc[CLS[c]] += m
            vcyc[CLS[c]] += m * cost(o)
            if builtin_name(o):
                heavy_ops_cls.append((pc, o, c, m))
        tot = sum(vc.values()) or 1
        totc = sum(vcyc.values()) or 1
        rec["variance"] = {
            "compute_ops_per_led": sum(vc.values()),
            "by_class_ops": dict(vc),
            "by_class_cycles": dict(vcyc),
            "hoistable_ops_pct": round(100 * (vc["const"] + vc["frame"]) / tot, 1),
            "memoizable_ops_pct": round(100 * vc["led"] / tot, 1),
            "hoistable_cycles_pct": round(100 * (vcyc["const"] + vcyc["frame"]) / totc, 1),
            "memoizable_cycles_pct": round(100 * vcyc["led"] / totc, 1),
        }
        # ---- source mapping for builtin ops (k-th occurrence per name per function)
        line_of = {}
        for e, f in entry_regions.items():
            occ = src_occurrences(lines, f["start"], f["end"])
            seen = Counter()
            for i in P.region(e):
                o = P.ops[i]
                b = builtin_name(o)
                if b:
                    k = seen[b]
                    seen[b] += 1
                    if k < len(occ.get(b, [])):
                        line_of[o["pc"]] = occ[b][k]
        rec["lint"] = lint(
            P,
            rec,
            src,
            lines,
            funcs,
            shade_reach,
            shade_counts,
            shade_loops,
            var,
            heavy_ops_cls,
            line_of,
            entry_regions,
        )
    else:
        rec["variance"] = None
        rec["lint"] = []
    return rec


def _src_line(lines, ln):
    return lines[ln - 1].strip()[:110] if ln and 0 < ln <= len(lines) else ""


def lint(
    P,
    rec,
    src,
    lines,
    funcs,
    shade_reach,
    counts,
    loops,
    var,
    heavy_ops_cls,
    line_of,
    entry_regions,
):
    W = []
    raw_lines = src.split("\n")

    def add(rule, msg, ln=None):
        W.append(
            {"rule": rule, "line": ln, "src": _src_line(raw_lines, ln) if ln else "", "msg": msg}
        )

    by = {f["name"]: f for f in funcs}
    shade_lines = sorted(
        {ln for n in shade_reach if n in by for ln in range(by[n]["start"], by[n]["end"] + 1)}
    )

    for pc, o, c, m in heavy_ops_cls:
        name = builtin_name(o)
        isfloat = heavy_name(o) is not None
        ln = line_of.get(pc)
        if not isfloat:
            continue
        if name in ("sin", "cos", "tan"):
            if c in (C, F):
                add(
                    "frame_invariant_in_shade",
                    f"float {name}() whose argument depends only on time/uniforms runs {N_LEDS}x per frame: "
                    f"compute it once in update() into a state",
                    ln,
                )
            else:
                add(
                    "float_trig_in_shade",
                    f"float {name}() per LED (~570 cycles): use a `fixed` phase in TURNS and sin(fixed) "
                    f"(integer LUT ~150 cycles)",
                    ln,
                )
        elif name == "exp":
            add(
                "exp_per_led",
                "exp() per LED for a decay/falloff (~700 cycles): use a clamp/mix ramp, "
                "a fixed polynomial or exp(fixed)",
                ln,
            )
        if c == L and name in (
            "atan2",
            "length",
            "distance",
            "normalize",
            "sqrt",
            "hash",
            "pow",
            "exp",
            "log",
            "sin",
            "cos",
            "smoothstep",
        ):
            add(
                "led_invariant_heavy",
                f"{name}() depends only on led.* (constant per LED): compute it once into a `buffer` "
                f"(first frame) and read it back",
                ln,
            )
        elif c in (C, F) and name not in ("sin", "cos", "tan"):
            add(
                "frame_invariant_in_shade",
                f"{name}() depends only on time/uniforms/consts: hoist to update() + state",
                ln,
            )
        if name in ("hsv2rgb", "palette") and c != Dy:
            add(
                "hsv2rgb_invariant",
                f"{name}() argument is {CLS[c]}-invariant: precompute the colour "
                + ("in update()" if c in (C, F) else "per LED into a buffer"),
                ln,
            )

    # cheap frame-invariant ops (aggregate)
    nfr = sum(
        m
        for pc, m in counts.items()
        if pc in var
        and var[pc]["res"] in (C, F)
        and P.ops[P.idx(pc)]["op"] not in NON_COMPUTE
        and not builtin_name(P.ops[P.idx(pc)])
    )
    if nfr >= 3:
        hint = [ln for ln in shade_lines if re.search(r"\b(time|dt)\b", lines[ln - 1])]
        add(
            "frame_invariant_in_shade",
            f"{nfr} cheap per-LED ops depend only on time/uniforms/consts (e.g. time*speed, "
            f"uniform*constant): precompute them in update()"
            + (f" (shade lines using time/dt: {', '.join(map(str, hint[:4]))})" if hint else ""),
        )

    # pow with small constant exponent
    for ln in shade_lines:
        for m in re.finditer(
            r"\bpow\s*\(([^,()]+(?:\([^()]*\))?[^,()]*),\s*([0-9]+(?:\.[0-9]*)?)\s*\)",
            lines[ln - 1],
        ):
            e = float(m.group(2))
            if e == int(e) or e in (0.5, 1.5):
                add(
                    "pow_const_exponent",
                    f"pow(x, {m.group(2)}) per LED (~1800 cycles): use multiplies"
                    + (" / sqrt" if e != int(e) else ""),
                    ln,
                )

    # length/distance compared against a threshold
    for n in shade_reach:
        f = by.get(n)
        if not f:
            continue
        dvars = {}
        for ln in range(f["start"], f["end"] + 1):
            t = lines[ln - 1]
            for m in re.finditer(r"\b(\w+)\s*=\s*(length|distance)\s*\(", t):
                dvars[m.group(1)] = ln
            if re.search(
                r"\b(length|distance)\s*\([^;]*\)\s*[<>]|[<>]=?\s*(length|distance)\s*\(", t
            ) or re.search(r"\bstep\s*\([^;]*\b(length|distance)\s*\(", t):
                add(
                    "length_compare",
                    "length/distance compared to a threshold: compare dot(d,d) with r*r",
                    ln,
                )
                continue
            for v in dvars:
                if (
                    re.search(rf"\b{v}\s*[<>]|[<>]=?\s*{v}\b|\bstep\s*\([^;]*\b{v}\b", t)
                    and dvars[v] != ln
                ):
                    add(
                        "length_compare",
                        f"`{v}` (a length/distance) is compared to a threshold: "
                        "compare squared distances instead (no sqrt)",
                        ln,
                    )
                    break

    # float division by a constant
    ndivc = 0
    for pc, m in counts.items():
        o = P.ops[P.idx(pc)]
        if o["op"] == "DIV" and pc in var:
            a = var[pc]["args"]
            k = o.get("n", 1)
            if a and Jall(a[len(a) - k :]) == C:
                ndivc += m
    if ndivc:
        hit = False
        for ln in shade_lines:
            t = lines[ln - 1]
            if re.search(r"/\s*\(?\s*[0-9]+\.[0-9]*", t) and not re.match(r"\s*int\b", t):
                add(
                    "div_by_const",
                    "float division by a constant (~290 cycles): multiply by the reciprocal",
                    ln,
                )
                hit = True
        if not hit:
            add(
                "div_by_const",
                f"{ndivc} float divisions by a constant per LED: multiply by the reciprocal",
            )

    # loops per LED
    fors = [ln for ln in shade_lines if re.search(r"\bfor\s*\(", lines[ln - 1])]
    for k, lp in enumerate(loops):
        if lp["trips"] * lp["outer_mult"] >= 2:
            add(
                "loop_per_led",
                f"loop over {lp['trips']}{'' if lp['known'] else '?'} items per LED "
                "(x500 LEDs): precompute per-item data in update() / bound the loop by distance",
                fors[k] if k < len(fors) else None,
            )

    # noise/hash octaves per LED
    nh = rec["per_led"]["float_heavy_by_name"].get("hash", 0)
    in_loop_hash = any(
        P.ops[P.idx(pc)]["op"] in ("HASH1", "HASH3") and m > 1 for pc, m in counts.items()
    )
    if nh >= 4 or in_loop_hash:
        hl = [ln for ln in shade_lines if re.search(r"\bhash\s*\(", lines[ln - 1])]
        add(
            "noise_octaves_per_led",
            f"{nh} hash() calls per LED (value-noise octaves/loops): bake the noise "
            "into a buffer/texture or use fewer octaves",
            hl[0] if hl else None,
        )

    # float literals mixed into fixed math
    fixed_names = set(re.findall(r"\bfixed(?:8|16)?\s+(\w+)", "\n".join(lines)))
    fixed_names -= {"buffer", "texture"}
    if fixed_names:
        nm = "|".join(map(re.escape, fixed_names))
        lit = r"(?<![\w.(])[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?(?![\w.])"
        pat = re.compile(
            rf"\b({nm})\s*[-+*/]\s*{lit}|{lit}\s*[-+*/]\s*({nm})\b"
            rf"|\bfixed(?:8|16)?\([^()]*\)\s*[-+*/]\s*{lit}|{lit}\s*[-+*/]\s*fixed(?:8|16)?\("
        )
        for ln in shade_lines:
            if pat.search(lines[ln - 1]):
                add(
                    "float_literal_in_fixed",
                    "float literal in fixed arithmetic promotes it to soft-float: "
                    "wrap the literal in fixed(...)",
                    ln,
                )
    nprom = 0
    ops = P.ops
    for i, o in enumerate(ops):
        if o["op"] == "FIX2F" and o["pc"] in counts:
            for j in range(i + 1, min(i + 8, len(ops))):
                if ops[j]["op"] in ("F2FIX", "FIX_FROM_F"):
                    nprom += counts[o["pc"]]
                    break
                if ops[j]["op"] in ("STORE_LOCAL", "TEE_LOCAL", "RET", "BR_FALSE", "JMP", "CALL"):
                    break
    rec["fixed_promotions_per_led"] = nprom
    if nprom and not any(w["rule"] == "float_literal_in_fixed" for w in W):
        add(
            "float_literal_in_fixed",
            f"{nprom} fixed->float->fixed round-trips per LED (a float literal or "
            "float value mixed into fixed math): keep both operands fixed",
        )

    # de-duplicate (rule, line)
    seen, out = set(), []
    for w in W:
        k = (w["rule"], w["line"], w["msg"][:40])
        if k not in seen:
            seen.add(k)
            out.append(w)
    return out


def lint_messages(src, fxc=DEFAULT_FXC):
    """Human-readable lint warnings (for the app_lint revision round)."""
    rec = analyze_source(src, fxc)
    if not rec.get("compile_ok"):
        return []
    msgs = []
    for w in rec["lint"]:
        loc = f"line {w['line']} (`{w['src']}`): " if w["line"] else ""
        msgs.append(f"{loc}{w['msg']}")
    pl = rec["per_led"]
    msgs.append(
        f"(estimate: ~{pl['est_cycles']} cycles per LED in shade vs a budget of "
        f"~{FRAME_CYCLES_PER_LED - FIRMWARE_FRAMING}; {pl['float_transcendentals']} float transcendentals "
        f"per LED; {rec['variance']['hoistable_ops_pct']}% of shade ops are frame-invariant)"
    )
    return msgs if rec["lint"] else []


# ----------------------------------------------------------------------------- summary


def name_parts(path):
    b = os.path.basename(path)[:-3]
    p = b.split("__")
    return (p + ["", "", ""])[:3] if len(p) >= 3 else (b, "", "")


def summarize(recs, runs_dir):
    groups = defaultdict(list)
    for r in recs:
        groups[(r["variant"], r["model_short"])].append(r)
    meta = {}
    for p in glob.glob(os.path.join(runs_dir, "*.json")):
        m = json.load(open(p))
        meta[m["name"]] = m
    L_ = []
    L_.append("# FX agent authoring — static perf summary\n")
    L_.append(
        f"Per-LED = shade + called functions, loops walked, all branch arms counted (upper bound). "
        f"Cycle estimate is rough (analyze.py COST), budget ~{FRAME_CYCLES_PER_LED - FIRMWARE_FRAMING} "
        f"cycles/LED for 500 LEDs at 30 fps after ~{FIRMWARE_FRAMING} framing.\n"
    )
    hdr = (
        "| variant | model | n | compiled | 1st-try ok | mean calls | uses fixed | mean float transc./LED "
        "| mean float arith/LED | mean int/fixed/LED | plumbing % of ops | est. cyc/LED median / mean | fits 33ms | hoistable ops % "  # noqa: E501
        "| hoistable cyc % | memoizable cyc % | shade loops | mean lint hits |"
    )
    L_.append(hdr)
    L_.append("|" + "---|" * (hdr.count("|") - 1))
    for (v, m), rs in sorted(groups.items()):
        ok = [r for r in rs if r.get("compile_ok")]
        mets = [meta.get(os.path.basename(r["name"])[:-3], {}) for r in rs]
        called = [x for x in mets if x.get("attempts")]
        first = sum(1 for x in called if x["attempts"][0].get("compile_ok"))
        calls = [x.get("n_calls", 0) for x in mets if x]
        statuses = sum(1 for x in mets if x.get("status") == "ok")

        def mean(f):
            xs = [f(r) for r in ok]
            return round(statistics.mean(xs), 2) if xs else 0

        est = [r["per_led"]["est_cycles"] for r in ok if r.get("per_led")]
        fits = sum(1 for r in ok if r.get("per_led") and r["per_led"]["est_frame_ms_500"] <= 33.3)
        L_.append(
            f"| {v} | {m} | {len(rs)} | {statuses}/{len(rs)} | {first}/{len(called)} | "
            f"{round(statistics.mean(calls), 2) if calls else '-'} | "
            f"{sum(1 for r in ok if r['uses_fixed_type'])}/{len(ok)} | "
            f"{mean(lambda r: r['per_led']['float_transcendentals'])} | "
            f"{mean(lambda r: r['per_led']['by_category'].get('float_arith', 0))} | "
            f"{mean(lambda r: r['per_led']['by_category'].get('int_fixed', 0))} | "
            f"{mean(lambda r: round(100 * r['per_led']['by_category'].get('plumbing', 0) / max(1, r['per_led']['ops']), 1))} | "  # noqa: E501
            f"{int(statistics.median(est)) if est else '-'} / {int(statistics.mean(est)) if est else '-'} | {fits}/{len(ok)} | "  # noqa: E501
            f"{mean(lambda r: r['variance']['hoistable_ops_pct'])} | "
            f"{mean(lambda r: r['variance']['hoistable_cycles_pct'])} | "
            f"{mean(lambda r: r['variance']['memoizable_cycles_pct'])} | "
            f"{sum(1 for r in ok if r['per_led'].get('loops'))}/{len(ok)} | "
            f"{mean(lambda r: len(r['lint']))} |"
        )
    # heavy builtins
    L_.append("\n## Float heavy builtins per LED (mean over compiled programs)\n")
    names = [
        "sin",
        "cos",
        "tan",
        "sqrt",
        "exp",
        "log",
        "pow",
        "atan2",
        "length",
        "distance",
        "normalize",
        "smoothstep",
        "hsv2rgb",
        "palette",
        "hash",
    ]
    L_.append("| variant | model | " + " | ".join(names) + " |")
    L_.append("|---|---|" + "---|" * len(names))
    for (v, m), rs in sorted(groups.items()):
        ok = [r for r in rs if r.get("compile_ok")]
        row = [
            (
                str(
                    round(
                        statistics.mean(
                            [r["per_led"]["float_heavy_by_name"].get(n, 0) for r in ok]
                        ),
                        2,
                    )
                )
                if ok
                else "-"
            )
            for n in names
        ]
        L_.append(f"| {v} | {m} | " + " | ".join(row) + " |")
    # lint
    rules = sorted({w["rule"] for r in recs for w in r.get("lint", [])})
    L_.append("\n## Perf-lint hits (hits / programs fired on)\n")
    keys = sorted(groups)
    L_.append("| rule | " + " | ".join(f"{v}/{m}" for v, m in keys) + " | all |")
    L_.append("|---|" + "---|" * (len(keys) + 1))
    for rule in rules:
        cells = []
        th = tp = 0
        for k in keys:
            rs = [r for r in groups[k] if r.get("compile_ok")]
            h = sum(1 for r in rs for w in r["lint"] if w["rule"] == rule)
            p = sum(1 for r in rs if any(w["rule"] == rule for w in r["lint"]))
            th += h
            tp += p
            cells.append(f"{h} / {p}")
        L_.append(f"| {rule} | " + " | ".join(cells) + f" | {th} / {tp} |")
    return "\n".join(L_) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="*")
    ap.add_argument("--fx-compile", default=os.environ.get("FX_COMPILE", DEFAULT_FXC))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "out"))
    ap.add_argument("--no-summary", action="store_true")
    a = ap.parse_args()
    ins = a.inputs or [os.path.join(REPO, "firmware", "fx_perf_bench", "agent")]
    files = []
    for x in ins:
        files += sorted(glob.glob(os.path.join(x, "*.fx"))) if os.path.isdir(x) else [x]
    recs = []
    for f in files:
        src = open(f).read()
        r = analyze_source(src, a.fx_compile, os.path.relpath(f, REPO))
        v, m, pid = name_parts(f)
        r.update({"variant": v, "model_short": m, "prompt_id": pid})
        recs.append(r)
    os.makedirs(a.out_dir, exist_ok=True)
    json.dump(recs, open(os.path.join(a.out_dir, "analysis.json"), "w"), indent=1)
    if not a.no_summary:
        s = summarize(recs, os.path.join(HERE, "out", "runs"))
        open(os.path.join(a.out_dir, "summary.md"), "w").write(s)
        print(s)
    print(f"analyzed {len(recs)} programs -> {a.out_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
