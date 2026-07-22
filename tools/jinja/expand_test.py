"""Unit tests for the jinja_template expander (expand.py)."""

import os
import tempfile
import unittest

from jinja2 import UndefinedError

from tools.jinja.expand import parse_defines, render


class ParseDefinesTest(unittest.TestCase):
    def test_splits_on_first_equals(self):
        self.assertEqual(
            parse_defines(["origin=https://x?a=b", "port=81"]),
            {"origin": "https://x?a=b", "port": "81"},
        )

    def test_rejects_malformed(self):
        with self.assertRaises(SystemExit):
            parse_defines(["no-equals"])
        with self.assertRaises(SystemExit):
            parse_defines(["=value-without-key"])


class RenderTest(unittest.TestCase):
    def _write(self, name: str, content: str) -> str:
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_substitutes_variables(self):
        path = self._write("t.j2", "origin={{ origin }} port={{ port }}\n")
        self.assertEqual(
            render(path, {"origin": "https://x", "port": "81"}),
            "origin=https://x port=81\n",
        )

    def test_undefined_variable_fails_loudly(self):
        # The reason this rule exists: sed shipped raw placeholders silently.
        path = self._write("t.j2", "{{ missing }}")
        with self.assertRaises(UndefinedError):
            render(path, {})

    def test_include_from_template_directory(self):
        self._write("partial.j2", "hello {{ who }}")
        path = self._write("t.j2", '{% include "partial.j2" %}!')
        self.assertEqual(render(path, {"who": "world"}), "hello world!")

    def test_trailing_newline_preserved(self):
        path = self._write("t.j2", "line\n")
        self.assertEqual(render(path, {}), "line\n")


if __name__ == "__main__":
    unittest.main()
