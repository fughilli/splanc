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

    def grant_scan_permissions(self, package: str = "") -> None:
        """Grant the browser the location permission BLE scanning needs. Android gates
        `navigator.bluetooth` scanning on ACCESS_FINE_LOCATION (the chooser otherwise
        shows "Chrome needs location access to scan for devices" and lists nothing).
        Granting via `pm grant` persists and needs no UI. Package defaults to Chrome
        (or the package half of $HITL_ANDROID_BROWSER)."""
        if not package:
            browser = os.environ.get("HITL_ANDROID_BROWSER", "")
            package = browser.split("/")[0] if "/" in browser else "com.android.chrome"
        for perm in (
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
        ):
            try:
                self._shell("pm", "grant", package, perm)
            except subprocess.SubprocessError:
                pass

    def _bt_on(self) -> bool:
        return self._shell("settings", "get", "global", "bluetooth_on", capture=True).strip() == "1"

    def ensure_bluetooth(self) -> None:
        """Turn the radio fully on (the chooser refuses with 'Turn on Bluetooth to
        allow pairing' otherwise). `svc bluetooth enable` is ignored on some Samsung
        builds (the adapter sits in BLE_ON / enabled:false), so fall back to tapping
        the Settings toggle, then return home. Idempotent — no-ops when already on."""
        if self._bt_on():
            return
        try:
            self._shell("svc", "bluetooth", "enable")
        except subprocess.SubprocessError:
            pass
        time.sleep(3.0)
        if self._bt_on():
            return
        # UI fallback: the Bluetooth settings screen's toggle Switch
        self._shell("am", "start", "-a", "android.settings.BLUETOOTH_SETTINGS")
        time.sleep(3.0)
        sw = self.find(cls="Switch")
        if sw and "off" in sw.text.lower():
            self.tap_node(sw)
            time.sleep(4.0)
        self._shell("input", "keyevent", "3")  # HOME, off the settings screen
        time.sleep(1.0)

    def hide_keyboard(self) -> None:
        """Dismiss the soft keyboard (BACK when it's up) so buttons below it — the
        'Scan for device' CTA — are visible + tappable at their un-occluded position."""
        self._shell("input", "keyevent", "4")
        time.sleep(1.0)

    def dismiss_dialogs(self) -> None:
        """Cancel any Bluetooth chooser / dialog left open by a prior run — it's a modal
        that would otherwise sit over the app's onboarding button. Tap 'Cancel' while
        one is present (bounded)."""
        for _ in range(3):
            cancel = next(
                (n for n in self.dump() if n.clickable and n.text.strip().lower() == "cancel"),
                None,
            )
            if not cancel:
                return
            self.tap_node(cancel)

    # --- the flow -----------------------------------------------------------
    def provision(self, ssid: str, password: str, name_match: str, timeout: float = 60.0) -> bool:
        """Run the full UI provisioning. Assumes the app is already open on its
        onboarding screen (caller serves + reverses + launches). Returns True once the
        chooser selection is accepted (the app then does Improv over the real radio)."""
        # 0) BLE scanning needs the browser's location permission (persists) + the radio on
        self.grant_scan_permissions()
        self.ensure_bluetooth()
        self.dismiss_dialogs()  # clear any chooser/dialog left open by a prior run

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

        # 3) hide the keyboard (it occludes the CTA) then fire the real chooser
        self.hide_keyboard()
        scan = self.find(text="Scan for device")
        if not scan:
            print("[ble-ui] no 'Scan for device' button", file=sys.stderr)
            return False
        self.tap_node(scan)

        # 4) the OS chooser populates as it discovers; poll for our row, then confirm
        # Our DUT is often weaker-signal than the lab's other Improv nodes, so it sorts
        # to the BOTTOM of the chooser, below the fold — scroll the list each poll until
        # it renders (the chooser is a scrollable list in the dialog's upper half). Let
        # the live list populate + stop re-sorting first, else scrolling chases a moving
        # target as new scan results reorder the rows.
        time.sleep(7)
        deadline = time.time() + timeout
        row = None
        while time.time() < deadline:
            row = find_chooser_row(self.dump(), name_match)
            if row:
                break
            self._shell("input", "swipe", "360", "500", "360", "250")
            time.sleep(1.5)
        if not row:
            print(f"[ble-ui] {name_match!r} never appeared in the chooser", file=sys.stderr)
            return False
        self.tap_node(row)
        time.sleep(1.5)  # let the row selection enable the confirm button
        # confirm button: an EXACT, clickable "Pair"/"Connect"/"Add" — NOT the dialog
        # title "<origin> wants to pair" (a non-clickable TextView that a substring
        # match would wrongly grab, leaving the chooser open).
        confirm = next(
            (
                n
                for n in self.dump()
                if n.clickable and n.text.strip().lower() in ("pair", "connect", "add")
            ),
            None,
        )
        if not confirm:
            print(
                "[ble-ui] no clickable Pair/Connect button after selecting the row", file=sys.stderr
            )
            return False
        self.tap_node(confirm)
        print(f"[ble-ui] selected {name_match!r} + tapped {confirm.text.strip()!r}", flush=True)
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
