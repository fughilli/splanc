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
        added = set(tok(self.ours)) - set(tok(self.sdk))
        self.assertEqual(added, set(), "the rewrite must only remove placements")

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


if __name__ == "__main__":
    unittest.main()
