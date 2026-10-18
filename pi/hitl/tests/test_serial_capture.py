"""Offline tests for the always-on DUT serial capture (serial_capture + its
Reservation wiring). The logger itself runs against a pty standing in for the C6's
USB-serial port."""

from __future__ import annotations

import base64
import os
import pty
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import hitl_client
import serial_capture as sc

PY = f"PY={shlex.quote(sys.executable)}; "


class NeedsPortTests(unittest.TestCase):
    def test_port_users_pause_the_capture(self) -> None:
        for cmd in (
            "hitl-flash /tmp/b.tar --erase-fs --monitor --monitor-seconds 12",
            "hitl-monitor --reset --seconds 3",
            "stty -F /dev/ttyACM0 raw -echo; printf '0' > /dev/ttyACM0",
            "python3 /tmp/led_freeze_probe.py",
            'esptool.py --port "$HITL_ESP_PORT" write_flash 0x0 a.bin',
            "python3 /tmp/hitl-ios/ios_serial_diag.py --monitor-only",
        ):
            self.assertTrue(sc.needs_port(cmd), cmd)

    def test_other_commands_leave_it_running(self) -> None:
        for cmd in (
            "PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision --ssid x",
            "python3 /tmp/wss_stream.py 10.42.0.5 443 0 24 24 1 3 30 10",
            "cat /tmp/x.json",
        ):
            self.assertFalse(sc.needs_port(cmd), cmd)


class WrapTests(unittest.TestCase):
    """Run the wrapped command for real against a stub logger that records calls."""

    def _run(self, cmd: str) -> tuple[int, list[str]]:
        with tempfile.TemporaryDirectory() as d:
            calls = os.path.join(d, "calls")
            with open(os.path.join(d, "logger.py"), "w") as f:
                f.write(f"import sys; open({calls!r}, 'a').write(sys.argv[1] + '\\n')\n")
            with mock.patch.object(sc, "PY_SELECT", PY):
                rc = subprocess.run(["sh", "-c", sc.wrap_port_cmd(cmd, d)]).returncode
            with open(calls) as f:
                return rc, f.read().split()

    def test_pause_resume_and_exit_status(self) -> None:
        self.assertEqual(self._run("hitl-flash x; true"), (0, ["stop", "start"]))
        # The command's own `exit` must not skip the resume, and its status survives.
        self.assertEqual(self._run("hitl-monitor --seconds 1; exit 3"), (3, ["stop", "start"]))

    def test_backgrounded_port_user_stays_paused(self) -> None:
        self.assertEqual(
            self._run("( nohup hitl-monitor --seconds 9 >/dev/null 2>&1 & ); true")[1], ["stop"]
        )


class LoggerTests(unittest.TestCase):
    """The shipped REMOTE_LOGGER, end to end, on a pty."""

    def test_captures_timestamped_lines_and_dumps(self) -> None:
        master, slave = pty.openpty()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "logger.py")
            with open(path, "w") as f:
                f.write(sc.REMOTE_LOGGER)
            # The logger runs as its own process: hand it this test's import path
            # (bazel's runfiles pyserial) the way the rig's toolbox python3 has it.
            env = dict(os.environ, HITL_TTY=os.ttyname(slave), PYTHONPATH=os.pathsep.join(sys.path))
            env.pop("HITL_ESP_PORT", None)
            start = subprocess.run(
                [sys.executable, path, "start", d], env=env, capture_output=True, text=True
            )
            self.assertIn("serial-capture: " + os.ttyname(slave), start.stdout)
            time.sleep(0.5)
            os.write(
                master,
                b'[boot] reset_reason=USB (11)\r\n[ble] advertising "HITL Test 1"\r\npartial',
            )
            time.sleep(1.2)  # > the 0.5s partial-line flush
            dump = subprocess.run(
                [sys.executable, path, "dump", d], env=env, capture_output=True, text=True
            ).stdout
        os.close(master)
        os.close(slave)
        logs = sc.parse_fetch(dump)
        self.assertEqual(list(logs), ["dut0.log"])
        lines = logs["dut0.log"].splitlines()
        body = [ln.split(" ", 1)[1] for ln in lines]
        self.assertIn("[boot] reset_reason=USB (11)", body)
        self.assertIn('[ble] advertising "HITL Test 1"', body)
        self.assertIn("partial", body)
        self.assertTrue(body[0].startswith("[capture] started on "))
        self.assertEqual(body[-1], "[capture] capture stopped at release")
        # Every line carries a UTC wall-clock stamp (HH:MM:SS.mmmZ) to line up with CI.
        for ln in lines:
            self.assertRegex(ln, r"^\d\d:\d\d:\d\d\.\d{3}Z ")


class HelperTests(unittest.TestCase):
    def test_log_filename(self) -> None:
        self.assertEqual(
            sc.log_filename("//pi/hitl/harness:e2e_netstack", "c6-123170", "ab12", "dut0.log"),
            "pi_hitl_harness_e2e_netstack--c6-123170--ab12--dut0.log",
        )

    def test_format_tail(self) -> None:
        text = "".join(f"line {i}\n" for i in range(200))
        out = sc.format_tail("c6-x dut0.log", text, n=3).splitlines()
        self.assertEqual(out[1:4], ["line 197", "line 198", "line 199"])
        self.assertIn("last 3 of 200 lines", out[0])

    def test_failure_classification(self) -> None:
        self.assertFalse(hitl_client._exc_is_failure(None))
        self.assertFalse(hitl_client._exc_is_failure(SystemExit(0)))
        self.assertTrue(hitl_client._exc_is_failure(SystemExit(1)))
        self.assertTrue(hitl_client._exc_is_failure(SystemExit("flash failed")))
        self.assertTrue(hitl_client._exc_is_failure(TimeoutError()))


class ReservationWiringTests(unittest.TestCase):
    def _res(self) -> hitl_client.Reservation:
        r = hitl_client.Reservation(server="http://rig:8087")
        r.user, r.host, r.port, r._keyfile = "u", "rig", 22, "/dev/null"
        r._serial_on = True
        return r

    def _sent(self, call) -> str:
        argv = call.call_args[0][0]
        return argv[-1]  # the shlex-quoted remote command

    def test_ssh_pauses_capture_only_for_port_users(self) -> None:
        r = self._res()
        with mock.patch.object(hitl_client.subprocess, "run") as run:
            r.ssh("hitl-flash /tmp/b.tar", capture=True)
            self.assertIn("logger.py stop", self._sent(run))
            r.ssh("cat /tmp/x", capture=True)
            self.assertNotIn("logger.py", self._sent(run))

    def test_ssh_serialized_wraps_inside_the_base64(self) -> None:
        r = self._res()
        with mock.patch.object(hitl_client.subprocess, "run") as run:
            r.ssh_serialized("hitl-flash /tmp/b.tar --monitor", capture=True)
        b64 = shlex.split(shlex.split(self._sent(run))[0])[-1]
        inner = base64.b64decode(b64).decode()
        self.assertIn("logger.py stop", inner)
        self.assertIn("hitl-flash /tmp/b.tar --monitor", inner)


if __name__ == "__main__":
    unittest.main()
