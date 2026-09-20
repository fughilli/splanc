"""Drive the app's REAL Web Bluetooth provisioning on a USB Android device via adb
UI automation — the one flow that cannot be run over the app-driver channel, because
`navigator.bluetooth.requestDevice()` requires a *trusted user gesture* (a real tap),
which the driver's programmatic `provisionBle` call is not.

Approach (chosen with the user): tap the app's own onboarding UI + the OS Bluetooth
chooser with `adb input tap`, reading the live view tree with `uiautomator dump` so
we click elements by their accessibility label/role rather than fragile fixed
coordinates. Chrome exposes the web page's a11y tree, so the app's buttons/fields and
the system chooser rows are all discoverable.

The app's BLE flow (observed on Chrome/Android, app onboarding screen):

  1. button  content-desc="Add device (Bluetooth)"   -> opens an in-app form
  2. EditText (SSID)  +  EditText (password=true)     -> the target Wi-Fi
  3. button  text="Scan for device"                   -> fires requestDevice()
  4. OS Bluetooth chooser lists Improv devices        -> pick ours by name, Pair

`name_match` disambiguates our DUT (e.g. "E2F5EF") from the other Improv nodes in a
crowded lab. Returns True once the chooser selection is accepted; the app then runs
Improv over the real radio and connects. Pure-planning bits (node parsing, matching)
are unit-tested in android_ble_provision_test.py without hardware.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass


@dataclass
class Node:
    text: str
    desc: str  # content-desc
    cls: str
    clickable: bool
    password: bool
    bounds: tuple[int, int, int, int]  # x1,y1,x2,y2

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.bounds
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.bounds
        return max(0, x2 - x1) * max(0, y2 - y1)


_NODE_RE = re.compile(r"<node\b[^>]*/?>")
_ATTR_RE = re.compile(r'(\w[\w-]*)="([^"]*)"')
_BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


def parse_nodes(xml: str) -> list[Node]:
    """Parse a `uiautomator dump` XML into flat Node records (attribute-only, so a
    self-contained regex parse is enough — no tree structure needed for tap targeting)."""
    out: list[Node] = []
    for m in _NODE_RE.finditer(xml):
        attrs = dict(_ATTR_RE.findall(m.group(0)))
        b = _BOUNDS_RE.search(attrs.get("bounds", ""))
        if not b:
            continue
        out.append(
            Node(
                text=attrs.get("text", ""),
                desc=attrs.get("content-desc", ""),
                cls=attrs.get("class", ""),
                clickable=attrs.get("clickable") == "true",
                password=attrs.get("password") == "true",
                bounds=(int(b.group(1)), int(b.group(2)), int(b.group(3)), int(b.group(4))),
            )
        )
    return out


def find_chooser_row(nodes: list[Node], name_match: str) -> Node | None:
    """The OS Bluetooth chooser row for our DUT: a node whose text/desc contains the
    disambiguating name fragment (case-insensitive), preferring a clickable one."""
    key = name_match.lower()
    cands = [n for n in nodes if key in n.text.lower() or key in n.desc.lower()]
    cands.sort(key=lambda n: (not n.clickable, -n.area))
    return cands[0] if cands else None


class AndroidBleProvisioner:
    """Drives one real-BLE provisioning on a USB Android device via adb + uiautomator."""

    def __init__(self, serial: str = "", step_pause: float = 1.5) -> None:
        self.serial = serial or os.environ.get("HITL_ANDROID_SERIAL", "")
        self.step_pause = step_pause

    # --- adb plumbing -------------------------------------------------------
    def _adb(self, *args: str, capture: bool = False, timeout: float = 30) -> str:
        cmd = ["adb"]
        if self.serial:
            cmd += ["-s", self.serial]
        cmd += list(args)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if capture:
            return r.stdout
        return ""

    def _shell(self, *args: str, **kw: object) -> str:
        return self._adb("shell", *args, **kw)  # type: ignore[arg-type]

    def dump(self) -> list[Node]:
        """Fetch + parse the current view tree (retry: dump can transiently fail)."""
        for _ in range(4):
            self._shell("uiautomator", "dump", "/sdcard/ui.xml", timeout=20)
            xml = self._shell("cat", "/sdcard/ui.xml", capture=True, timeout=20)
            nodes = parse_nodes(xml)
            if nodes:
                return nodes
            time.sleep(0.5)
        return []

    def tap(self, x: int, y: int) -> None:
        self._shell("input", "tap", str(x), str(y))
        time.sleep(self.step_pause)

    def type_text(self, s: str) -> None:
        # adb input text needs %s for spaces and escaping of shell-special chars.
        esc = s.replace("%", "%%").replace(" ", "%s")
        self._shell("input", "text", esc)
        time.sleep(0.6)

    def screenshot(self, path: str) -> int:
        png = subprocess.run(
            ["adb"]
            + (["-s", self.serial] if self.serial else [])
            + ["exec-out", "screencap", "-p"],
            capture_output=True,
            timeout=30,
        ).stdout
        with open(path, "wb") as fh:
            fh.write(png)
        return len(png)

    # --- element helpers ----------------------------------------------------
    def find(self, *, text: str = "", desc: str = "", cls: str = "", password: bool | None = None):
        for n in self.dump():
            if text and text.lower() not in n.text.lower():
                continue
            if desc and desc.lower() not in n.desc.lower():
                continue
            if cls and cls not in n.cls:
                continue
            if password is not None and n.password != password:
                continue
            return n
        return None

    def tap_node(self, n: Node) -> None:
        x, y = n.center
        self.tap(x, y)

    # --- the flow -----------------------------------------------------------
    def provision(self, ssid: str, password: str, name_match: str, timeout: float = 60.0) -> bool:
        """Run the full UI provisioning. Assumes the app is already open on its
        onboarding screen (caller serves + reverses + launches). Returns True once the
        chooser selection is accepted (the app then does Improv over the real radio)."""
        # 1) open the in-app BLE form
        btn = self.find(desc="Add device (Bluetooth)")
        if not btn:
            print("[ble-ui] no 'Add device (Bluetooth)' button on screen", file=sys.stderr)
            return False
        self.tap_node(btn)

        # 2) fill SSID + password. The SSID is the non-password EditText, the secret is
        #    the password=true EditText. Tap each, then type.
        edits = [n for n in self.dump() if "EditText" in n.cls and n.desc != "url_bar"]
        ssid_field = next((n for n in edits if not n.password), None)
        pw_field = next((n for n in edits if n.password), None)
        if not ssid_field or not pw_field:
            print(f"[ble-ui] creds form not found (edits={len(edits)})", file=sys.stderr)
            return False
        self.tap_node(ssid_field)
        self.type_text(ssid)
        self.tap_node(pw_field)
        self.type_text(password)

        # 3) fire the real chooser
        scan = self.find(text="Scan for device")
        if not scan:
            print("[ble-ui] no 'Scan for device' button", file=sys.stderr)
            return False
        self.tap_node(scan)

        # 4) the OS chooser populates as it discovers; poll for our row, then confirm
        deadline = time.time() + timeout
        row = None
        while time.time() < deadline:
            row = find_chooser_row(self.dump(), name_match)
            if row:
                break
            time.sleep(1.0)
        if not row:
            print(f"[ble-ui] {name_match!r} never appeared in the chooser", file=sys.stderr)
            return False
        self.tap_node(row)
        # confirm button: "Pair"/"Connect"/"Add" (varies by OS). Tap if present.
        confirm = self.find(text="Pair") or self.find(text="Connect") or self.find(text="Add")
        if confirm:
            self.tap_node(confirm)
        print(f"[ble-ui] selected {name_match!r} in the chooser", flush=True)
        return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial", default=os.environ.get("HITL_ANDROID_SERIAL", ""))
    ap.add_argument("--ssid", required=True)
    ap.add_argument("--password", default="")
    ap.add_argument("--name-match", required=True, help="fragment identifying the DUT, e.g. E2F5EF")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--shot", default="", help="write a screenshot here at the end")
    args = ap.parse_args()
    p = AndroidBleProvisioner(serial=args.serial)
    ok = p.provision(args.ssid, args.password, args.name_match, timeout=args.timeout)
    if args.shot:
        p.screenshot(args.shot)
    print("[ble-ui] PROVISION", "OK" if ok else "FAILED", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
