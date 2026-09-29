"""Dry-run tests for ios_reservation.py — the reservation-driven iOS runner's pure
planning surface (payload manifest + tar staging + remote command), no reservation,
no hardware, no ssh."""

from __future__ import annotations

import os
import tarfile
import tempfile
import unittest

import ios_reservation as ir


class ManifestTests(unittest.TestCase):
    def test_manifest_ships_the_harness_app_and_firmware(self) -> None:
        arcs = [arc for _, arc in ir.payload_manifest()]
        # The harness the Mac runs, the app the station serves, and the C6 bundle.
        self.assertIn("phone_e2e.py", arcs)
        self.assertIn("driver_server.py", arcs)
        self.assertIn("serial_discovery.py", arcs)
        self.assertIn("web/dist", arcs)
        self.assertIn("solver", arcs)
        self.assertIn("journeys", arcs)
        self.assertTrue(any("flashbundle" in a for a in arcs))

    def test_no_device_identifiers_in_source(self) -> None:
        # Device IDs (UDID / MAC / serial) must NOT be hardcoded — they come from the
        # reservation env. Guard against a regression that bakes one in.
        src = open(os.path.join(os.path.dirname(__file__), "ios_reservation.py")).read()
        self.assertNotIn("00008110", src)  # the iPhone UDID prefix
        self.assertNotIn("8C:FD:49", src)  # the C6 BT MAC prefix


class StageTests(unittest.TestCase):
    def test_stage_skips_missing_and_tars_present(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            # Fake sources: a file and a dir present, plus one that's absent.
            f = os.path.join(td, "a.py")
            open(f, "w").write("print(1)\n")
            d = os.path.join(td, "web_dist")
            os.makedirs(os.path.join(d, "sub"))
            open(os.path.join(d, "index.html"), "w").write("<html>")

            def resolve(rel):
                return {"present.py": f, "web/dist": d}.get(rel)

            manifest = [
                ("present.py", "present.py"),
                ("web/dist", "web/dist"),
                ("missing.tar", "firmware/x.tar"),  # resolve() returns None -> skipped
            ]
            tarpath = os.path.join(td, "out.tar")
            included = ir.stage_payload(tarpath, resolve=resolve, manifest=manifest)
            self.assertEqual(included, ["present.py", "web/dist"])
            with tarfile.open(tarpath) as t:
                names = t.getnames()
            self.assertIn("present.py", names)
            self.assertIn("web/dist/index.html", names)
            self.assertNotIn("firmware/x.tar", names)


class RemoteCmdTests(unittest.TestCase):
    def test_remote_run_cmd_has_env_and_flags(self) -> None:
        cmd = ir.remote_run_cmd(
            ir.STATION_IP_EXPR,
            journeys="smoke",
            ble_mode="virtual",
            build_port=8099,
            ready_timeout=120.0,
        )
        # Runs from the shipped root, resolves the Mac's own LAN IP, points at the
        # loopback build server, and passes the shipped app dirs via env.
        self.assertIn(f"cd {ir.REMOTE_ROOT}", cmd)
        # nix pyEnv python (with websockets) must win over the system /usr/bin/python3.
        self.assertIn("PATH=/run/current-system/sw/bin:$PATH", cmd)
        self.assertIn('HITL_STATION_IP="$(ipconfig getifaddr en0', cmd)
        self.assertIn("IOS_BUILD_SERVER=http://127.0.0.1:8099", cmd)
        self.assertIn(f"HITL_WEB_DIST={ir.REMOTE_ROOT}/web/dist", cmd)
        self.assertIn(f"PYTHONPATH={ir.REMOTE_ROOT}", cmd)
        self.assertIn("phone_e2e.py", cmd)
        self.assertIn("--phone-target ios-phone", cmd)
        self.assertIn("--journeys smoke", cmd)
        self.assertIn("--ble-mode virtual", cmd)
        # UDID is NOT injected here — it rides in from the reservation env.
        self.assertNotIn("HITL_IOS_UDID", cmd)

    def test_remote_run_cmd_device_ws_for_connect(self) -> None:
        cmd = ir.remote_run_cmd(
            ir.STATION_IP_EXPR,
            journeys="connect,config",
            ble_mode="real",
            build_port=8099,
            ready_timeout=120.0,
            device_ws="wss://192.0.2.5:8443/ws",
        )
        self.assertIn("--device-ws wss://192.0.2.5:8443/ws", cmd)
        self.assertIn("--journeys connect,config", cmd)

    def test_discover_c6_cmd_uses_adapter_serial_and_fallback(self) -> None:
        cmd = ir.discover_c6_cmd()
        self.assertIn("serial_discovery.py", cmd)
        self.assertIn("--serial $HITL_ADAPTER_SERIAL", cmd)
        self.assertIn('--fallback "$HITL_ESP_PORT"', cmd)


if __name__ == "__main__":
    unittest.main()
