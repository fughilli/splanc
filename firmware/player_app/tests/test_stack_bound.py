"""Gate: every task's static worst-case stack (tools/stack_bound over the shipped
ELF, manifest firmware/player_app/stack_bound.json) fits its reserved stack with
margin, and no unaccounted dynamic allocation or recursion is reachable."""

import json
import os
import re
import unittest

import stack_bound


def runfile(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    assert p and os.path.exists(p), rel
    return p


class StackBoundTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(runfile("_main/firmware/player_app/stack_bound.json")) as f:
            cls.manifest = json.load(f)
        dis = stack_bound.objdump(runfile(os.environ["OBJDUMP"]), runfile(os.environ["ELF"]))
        cls.b = stack_bound.Bound(stack_bound.parse(dis), cls.manifest)
        cls.results = {r["name"]: (r, cls.b.depth(r["symbol"])) for r in cls.manifest["roots"]}

    def reserved(self, root):
        path, pattern, scale = root["reserved_from"]
        with open(runfile("_main/" + path)) as f:
            m = re.search(pattern, f.read())
        self.assertIsNotNone(m, f"{root['name']}: {pattern!r} not found in {path}")
        return int(m.group(1)) * scale

    def test_every_root_fits_its_stack(self):
        report = []
        for name, (root, (bound, path)) in self.results.items():
            self.assertIn(root["symbol"], self.b.f, f"root {root['symbol']} not in the ELF")
            need = (bound + self.manifest["isr_context_bytes"]) * self.manifest["margin"]
            have = self.reserved(root)
            report.append(
                f"{name}: bound {bound} B, needs {need:.0f} B with margin, reserved {have} B"
            )
            via = " > ".join(p.split("(")[0] for p in path[:12])
            self.assertLessEqual(need, have, f"{name} stack too small: {report[-1]}\n  via {via}")
        print("\n".join(report))

    def test_dynamic_allocations_are_declared(self):
        undeclared = self.b.dyn_seen - set(self.manifest["dynamic_allocations"])
        self.assertEqual(undeclared, set(), "VLA/alloca reachable from a task without an allowance")

    def test_no_new_recursion(self):
        new = self.b.cycles - set(self.manifest["accepted_cycles"])
        self.assertEqual(new, set(), "new recursion reachable from a task (unbounded stack)")


if __name__ == "__main__":
    unittest.main()
