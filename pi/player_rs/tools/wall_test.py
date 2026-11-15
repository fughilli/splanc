"""Unit tests for the //pi/player_rs:wall launcher's argv + instructions."""

import unittest

import wall


class WallArgs(unittest.TestCase):
    def test_defaults(self):
        argv = wall.player_args([], "/w")
        self.assertEqual(wall.flag(argv, "--output", ""), "null")
        self.assertEqual(wall.flag(argv, "--leds", ""), "400")
        self.assertEqual(wall.flag(argv, "--web-root", ""), "/w")
        self.assertEqual(wall.flag(argv, "--state-dir", "x"), "")

    def test_user_flags_win(self):
        argv = wall.player_args(["--leds", "900", "--name", "Desk", "--serve-port", "9443"], "/w")
        self.assertEqual(argv.count("--leds"), 1)
        self.assertEqual(wall.flag(argv, "--leds", ""), "900")
        self.assertEqual(
            wall.flag(argv, "--name", ""), "Desk"
        )  # the later --name wins in player_host

    def test_an_output_replaces_the_null_default(self):
        # --output is repeatable in player_host (outputs add up), so the default
        # null must not be added next to a real one.
        argv = wall.player_args(["--output", "ddp://wled.local"], "/w")
        self.assertEqual(argv.count("--output"), 1)

    def test_instructions_name_both_urls(self):
        text = wall.instructions("8443", "192.168.1.20", "400")
        self.assertIn("https://localhost:8443/wall.html", text)
        self.assertIn("wss://192.168.1.20:8443", text)
        self.assertIn("<this computer's IP>", wall.instructions("8443", None, "400"))
        self.assertIn("https://192.168.1.20:8443/app/", text)

    def test_web_root_stages_the_solver_next_to_the_app(self):
        import os
        import tempfile

        dist = tempfile.mkdtemp()
        solver = tempfile.mkdtemp()
        open(os.path.join(dist, "index.html"), "w").close()
        root = wall.stage_web_root(dist, solver)
        self.assertTrue(os.path.isfile(os.path.join(root, "index.html")))
        self.assertEqual(os.path.realpath(os.path.join(root, "solver")), os.path.realpath(solver))
        self.assertEqual(wall.stage_web_root(dist, None), dist)


if __name__ == "__main__":
    unittest.main()
