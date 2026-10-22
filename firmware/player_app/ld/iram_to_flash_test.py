"""The rewritten sections.ld differs from the SDK's ONLY by the listed moves:
every removed file token belongs to a rule, every rule's RAM placement lines are
gone, and no other line changed."""

import re
import unittest
from pathlib import Path

import iram_to_flash

HERE = Path(__file__).parent


def runfile(suffix):
    hits = [p for p in Path(".").rglob("sections.ld") if str(p).endswith(suffix)]
    assert hits, f"no runfile ending {suffix}"
    return hits[0].read_text()


class RewriteTest(unittest.TestCase):
    def setUp(self):
        self.sdk = runfile("sdk/esp32c6/ld/sections.ld")
        self.ours = runfile("player_app/ld/esp32c6/sections.ld")
        self.rules = iram_to_flash.parse_rules((HERE / "esp32c6_iram_to_flash.txt").read_text())

    def test_only_listed_files_move(self):
        tok = lambda s: re.findall(r"\*lib[^\s()]+", s)  # noqa: E731
        removed = set(tok(self.sdk)) - set(tok(self.ours))
        for t in removed:
            lib = t[1:].split(":", 1)[0]
            self.assertTrue(
                any(r[0].split(":", 1)[0] == lib for r in self.rules),
                f"{t} moved but no rule lists it",
            )
        # The only additions are the per-object carve-outs (rule kind 3): their
        # EXCLUDE_FILE entries + explicit flash statements.
        added = set(tok(self.ours)) - set(tok(self.sdk))
        carved = {"*" + r[0] + ".*" for r in self.rules if ":" in r[0] and r[1]}
        self.assertLessEqual(added, carved, "the rewrite must only move listed sections")

    def test_ram_placement_lines_are_gone(self):
        for line in self.ours.splitlines():
            s = line.strip()
            for spec, secs in self.rules:
                if s.startswith("*" + spec.split(":")[0]) and "EXCLUDE_FILE" not in s:
                    if ":" in spec and not s.startswith("*" + spec + "."):
                        continue
                    if secs and not any(x in s for x in secs):
                        continue
                    # Allowed only outside the RAM sections; re-run the rewrite to
                    # confirm it would not drop it again (idempotence).
                    _, hits = iram_to_flash.rewrite(line + "\n", [(spec, secs)])
                    self.assertEqual(sum(hits.values()), 0, line)

    def test_idempotent(self):
        again, _ = iram_to_flash.rewrite(self.ours, self.rules)
        self.assertEqual(again, self.ours)

    def test_line_count_changes_only_by_deleted_placements(self):
        _, hits = iram_to_flash.rewrite(self.sdk, self.rules)
        self.assertLess(
            len(self.sdk.splitlines()) - len(self.ours.splitlines()), sum(hits.values()) + 1
        )

    def test_iram_pins_land_in_iram0_text(self):
        # Rule kind 4: each `iram:` rule is one `*(...)` statement inside
        # .iram0.text (right after `*(.iram1 .iram1.*)`), i.e. before the flash
        # catch-alls in script order, and nowhere else.
        pins = [r for r in self.rules if r[0] == "iram:"]
        self.assertTrue(pins)
        lines = self.ours.splitlines()
        iram = next(i for i, ln in enumerate(lines) if ln.strip().startswith(".iram0.text"))
        flash = next(i for i, ln in enumerate(lines) if ln.strip().startswith(".flash.text"))
        for _, secs in pins:
            stmt = "*(" + " ".join(secs) + ")"
            at = [i for i, ln in enumerate(lines) if ln.strip() == stmt]
            self.assertEqual(len(at), 1, stmt)
            self.assertTrue(iram < at[0] < flash, stmt)
            self.assertEqual(lines[at[0] - 1].strip(), "*(.iram1 .iram1.*)")

    def test_interpreter_dispatch_tables_are_in_sram(self):
        # fx_vm::run's jump tables are read on every opcode of every LED; in flash
        # their offset (any rodata growth shifts it) swung fx_bench by up to +45%.
        pins = [x for r in self.rules if r[0] == "iram:" for x in r[1]]
        self.assertIn(".rodata._ZN15ledmapper_fx_vm3run*", pins)

    def test_flash_first_pins_open_flash_text(self):
        # Rule kind 5: each `flash-first:` rule is one `*(...)` statement that is the
        # first statement of .flash.text, so the per-frame render path's flash
        # address doesn't depend on how much app code precedes it in link order.
        pins = [r for r in self.rules if r[0] == "flash-first:"]
        self.assertTrue(pins)
        lines = self.ours.splitlines()
        flash = next(i for i, ln in enumerate(lines) if ln.strip().startswith(".flash.text"))
        body = next(i for i in range(flash, len(lines)) if "{" in lines[i])
        for _, secs in pins:
            stmt = "*(" + " ".join(secs) + ")"
            at = [i for i, ln in enumerate(lines) if ln.strip() == stmt]
            self.assertEqual(len(at), 1, stmt)
            self.assertEqual(at[0], body + 1, "must be the first .flash.text statement")
        for sec in ("render_once", "lm_fx_update", "ledmapper_fx_vm2Vm"):
            self.assertTrue(any(sec in x for _, secs in pins for x in secs), sec)


if __name__ == "__main__":
    unittest.main()
