"""Static worst-case stack bound for a RISC-V firmware ELF.

Reads `objdump -d` of the final ELF, so it sees our C++, our Rust and the
prebuilt vendor blobs alike (which -fstack-usage / cargo-call-stack cannot):

- frame: the constant stack decrements in each function (`addi sp,sp,-N`, or
  `lui/li` + `sub sp,sp,reg` with the register's value tracked until it is
  overwritten); a `sub sp,sp,reg` of an unknown value is a DYNAMIC allocation
  (VLA/alloca), which needs a declared allowance;
- edges: direct calls (`jal`/`auipc+jalr` targets objdump annotates) and tail
  jumps into another function (the callee reuses the caller's frame);
- holes it reports instead of guessing: indirect calls (`jalr reg`), dynamic
  allocations and recursion (cycles).

The manifest (JSON) supplies what the binary can't: indirect edges (e.g. the
mbedtls bio callbacks), never-returning callees to prune (panic/unwind paths),
dynamic-allocation allowances, accepted (vendor) cycles, and the roots with
their reserved stacks. See firmware/player_app/stack_bound.json.
"""

import json
import re
import subprocess
import sys

FN = re.compile(r"^([0-9a-f]{8}) <(.+)>:$")
INS = re.compile(r"^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$")
TGT = re.compile(r"([0-9a-f]{8}) <([^>+]+)(\+0x[0-9a-f]+)?>")
CALLS = ("jal", "jalr", "c.jal", "c.jalr", "call")
JUMPS = CALLS + ("j", "jr", "c.j", "c.jr", "tail")


def _int(s):
    try:
        return int(s, 0)
    except ValueError:
        return None


def parse(disassembly):
    """name -> {frame, calls, tails, indirect, dyn}"""
    funcs, cur, regval = {}, None, {}
    for line in disassembly.splitlines():
        m = FN.match(line)
        if m:
            cur = dict(frame=0, calls=set(), tails=set(), indirect=0, dyn=False)
            funcs[m.group(2)] = cur
            name, regval = m.group(2), {}
            continue
        m = INS.match(line) if cur is not None else None
        if not m:
            continue
        op, args = m.group(2), m.group(3)
        a = [x.strip() for x in args.split("#")[0].split(",")]
        # A tracked constant dies when anything else writes the register.
        same_addi = op == "addi" and len(a) == 3 and a[0] == a[1]
        if a and a[0] in regval and op not in ("lui", "li") and not same_addi:
            if not (op == "sub" and a[0] == "sp"):
                del regval[a[0]]
        if op in ("addi", "c.addi16sp", "c.addi") and len(a) == 3 and a[:2] == ["sp", "sp"]:
            v = _int(a[2])
            if v is not None and v < 0:
                cur["frame"] += -v
        elif op == "lui" and len(a) == 2 and _int(a[1]) is not None:
            regval[a[0]] = _int(a[1]) << 12
        elif op == "li" and len(a) == 2 and _int(a[1]) is not None:
            regval[a[0]] = _int(a[1])
        elif same_addi and a[0] in regval and _int(a[2]) is not None:
            regval[a[0]] += _int(a[2])
        elif op == "sub" and len(a) == 3 and a[:2] == ["sp", "sp"]:
            v = regval.get(a[2])
            if v is not None and 0 < v < 0x10000:
                cur["frame"] += v
            else:
                cur["dyn"] = True
        elif op in JUMPS:
            is_call = op in CALLS and not (
                op == "jalr" and args.split("(")[0].strip() in ("zero", "x0")
            )
            t = TGT.search(args)
            if t:
                tname = t.group(2)
                if t.group(3):
                    continue  # a branch inside a function
                if tname == name and not is_call:
                    continue
                (cur["calls"] if is_call else cur["tails"]).add(tname)
            elif op in ("jr", "c.jr") and a[0] == "ra":
                continue  # return
            elif op in ("jalr", "c.jalr", "jr", "c.jr"):
                cur["indirect"] += 1  # an indirect call, or a jump table
    return funcs


class Bound:
    def __init__(self, funcs, manifest):
        self.f = funcs
        self.prune = [re.compile(p) for p in manifest.get("noreturn", [])]
        self.dyn_allow = manifest.get("dynamic_allocations", {})
        self.cycles_ok = set(manifest.get("accepted_cycles", []))
        for e in manifest.get("indirect_edges", []):
            callers = re.compile(e["callers"])
            for n, fn in funcs.items():
                if fn["indirect"] and callers.search(n):
                    fn["calls"] |= {c for c in funcs if any(c.startswith(x) for x in e["callees"])}
        self.memo, self.onstack = {}, set()
        self.cycles, self.dyn_seen = set(), set()

    def pruned(self, name):
        return any(p.search(name) for p in self.prune)

    def depth(self, name):
        """(bytes, path) of the deepest stack from `name`'s entry."""
        if name in self.memo:
            return self.memo[name]
        fn = self.f.get(name)
        if fn is None:
            return (0, [name + " (?)"])  # ROM or unknown: a leaf
        if name in self.onstack:
            self.cycles.add(name)
            return (0, [name + " (cycle)"])
        self.onstack.add(name)
        own = fn["frame"]
        if fn["dyn"]:
            self.dyn_seen.add(name)
            own += self.dyn_allow.get(name, 0)
        best = (0, [])
        for c in sorted(fn["calls"]):
            if not self.pruned(c):
                d = self.depth(c)
                if d[0] > best[0]:
                    best = d
        res = (own + best[0], [name] + best[1])
        for t in sorted(fn["tails"]):
            if not self.pruned(t):
                d = self.depth(t)
                if d[0] > res[0]:
                    res = (d[0], [name + " ->tail"] + d[1])
        self.onstack.discard(name)
        self.memo[name] = res
        return res

    def frame(self, name):
        return self.f.get(name.split(" ")[0], {}).get("frame", 0)


def objdump(tool, elf):
    return subprocess.run(
        [tool, "-d", "--no-show-raw-insn", "-C", elf], check=True, capture_output=True, text=True
    ).stdout


def main():
    tool, elf, manifest = sys.argv[1:4]
    b = Bound(parse(objdump(tool, elf)), json.load(open(manifest)))
    for root in json.load(open(manifest))["roots"]:
        n, path = b.depth(root["symbol"])
        print(f"== {root['name']}: {n} B")
        acc = 0
        for p in path:
            acc += b.frame(p)
            print(f"   {b.frame(p):6d} {acc:7d}  {p[:110]}")


if __name__ == "__main__":
    main()
