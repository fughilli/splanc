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
import html
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
                # uiautomator XML-escapes label text (e.g. "Accept &amp; continue");
                # unescape so callers match against the real on-screen string.
                text=html.unescape(attrs.get("text", "")),
                desc=html.unescape(attrs.get("content-desc", "")),
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


def find_network_row(nodes: list[Node], ssid: str) -> Node | None:
    """The Wi-Fi settings list row for `ssid`: a node whose text OR content-desc
    contains the SSID (Samsung OneUI sometimes carries it only in content-desc, and
    off-screen rows aren't in the dump until scrolled). Prefer the clickable row (or
    the largest node) so tapping it opens the connect sheet, not a sub-label."""
    key = ssid.lower()
    cands = [n for n in nodes if key in n.text.lower() or key in n.desc.lower()]
    cands.sort(key=lambda n: (not n.clickable, -n.area))
    return cands[0] if cands else None


# Chrome's first-run / sign-in / sync / notification walls, in the order we must clear
# them: ACCEPT the Terms of Service (nothing loads until it's accepted), then DECLINE
# the sign-in/sync prompts, then DENY any notification permission, then dismiss a
# generic leftover dialog. Matched against a node's text/content-desc (lowercased);
# distinctive enough not to collide with the LED-mapper app's own buttons ("Add device
# (Bluetooth)", "Scan for device", "Connect").
_FIRST_RUN_PATTERNS = (
    # Terms-of-Service welcome ("Accept & continue"), on builds that show it standalone.
    "accept & continue",
    "accept and continue",
    # The modern combined welcome ("Make Chrome your own … By continuing you agree to the
    # Terms of Service") proceeds via "Stay signed out" / "Use without an account" — these
    # ALSO accept the ToS, so they're how we clear the wall on this phone's Chrome.
    "stay signed out",
    "use without an account",
    "use without signing in",
    "continue without an account",
    "no thanks",
    "no, thanks",
    "turn on sync",  # the Samsung/Chrome sync dialog's heading sits above a "No thanks"
    "maybe later",
    "not now",
    "no, i'm not interested",
    # Notification / page permission prompts.
    "don't allow",
    "deny",
    "block",
    # Generic leftover dialog dismissals (lowest precedence).
    "got it",
    "dismiss",
)


def find_first_run_button(nodes: list[Node]) -> Node | None:
    """Return the node to tap to clear the current Chrome first-run / permission wall,
    following `_FIRST_RUN_PATTERNS` precedence (ToS accept first, then decline sign-in,
    then deny notifications). None when no such wall is on screen. Pure (unit-tested)."""
    for pat in _FIRST_RUN_PATTERNS:
        hit: Node | None = None
        for n in nodes:
            t, d = n.text.strip().lower(), n.desc.strip().lower()
            if t == pat or d == pat or t.startswith(pat) or d.startswith(pat):
                if n.clickable:
                    return n
                hit = hit or n
        if hit is not None:
            return hit
    return None


def parse_wifi_ssid(dumpsys_wifi: str) -> str:
    """The SSID the phone is associated to, from `dumpsys wifi` (empty if none). Reads
    the `mWifiInfo … SSID: <ssid>, BSSID: …` line and only trusts it when the
    supplicant has COMPLETED association. Works on Android 10, where `cmd wifi status`
    is root-gated. Pure (unit-tested)."""
    m = re.search(r'SSID:\s*"?([^",\n]+?)"?,\s*BSSID', dumpsys_wifi)
    if not m:
        return ""
    ssid = m.group(1).strip()
    if ssid.lower() in ("", "<unknown ssid>", "null", "<none>", "0x"):
        return ""
    if re.search(r"Supplicant state:\s*COMPLETED", dumpsys_wifi):
        return ssid
    # Some builds don't print the supplicant line in this block; fall back to the
    # network-state marker if present, else accept a concrete SSID.
    if re.search(r"(mNetworkInfo.*state:\s*CONNECTED|NetworkInfo.*CONNECTED)", dumpsys_wifi):
        return ssid
    return ssid


def parse_connectivity_ssid(dumpsys_connectivity: str) -> str:
    """The active WIFI network's SSID from `dumpsys connectivity` (the NetworkAgentInfo
    `extra:` field), empty if there is no connected WIFI network. A second, independent
    read of association used to confirm `parse_wifi_ssid`. Pure (unit-tested)."""
    m = re.search(r'WIFI[^\n]*?extra:\s*"([^"]+)"', dumpsys_connectivity)
    return m.group(1).strip() if m else ""


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

    def current_ssid(self) -> str:
        """The SSID the phone is currently associated to (empty if none). Read-only;
        works on Android 10, where `cmd wifi status` is root-gated for the shell uid.
        Cross-checks `dumpsys wifi` against `dumpsys connectivity` — a concrete SSID
        from either is good enough (the connectivity read only has it once the network
        is validated)."""
        ssid = parse_wifi_ssid(self._shell("dumpsys", "wifi", capture=True, timeout=25))
        if ssid:
            return ssid
        return parse_connectivity_ssid(
            self._shell("dumpsys", "connectivity", capture=True, timeout=25)
        )

    def _wait_assoc(self, ssid: str, timeout: float) -> bool:
        """Poll until the phone is associated to `ssid`, up to `timeout` seconds."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.current_ssid() == ssid:
                return True
            time.sleep(2.0)
        return False

    def join_wifi(self, ssid: str, psk: str, verify_timeout: float = 35.0) -> bool:
        """Put the phone on the WPA2 network `ssid`, idempotently, and VERIFY it.

        `cmd wifi connect-network` is root-gated on this phone (Android 10:
        "Uid 2000 does not have access to wifi commands"), and `adb root` is blocked on
        the production Samsung build, so there is no programmatic connect — the Settings
        UI is the only non-root path on API 29. We make it reliable instead of blind:

          1. enable Wi-Fi + Location (Wi-Fi scan results need Location on, or the list
             comes back empty — the "not in the network list" failure);
          2. fast-path: if already associated to `ssid`, done (idempotent);
          3. let a SAVED network auto-reconnect after the radio comes up;
          4. otherwise drive the Wi-Fi settings list (match by text OR content-desc,
             scroll to reveal weak/below-the-fold APs, type the PSK on a fresh network);
          5. confirm REAL association via dumpsys — return True only when on `ssid`,
             so the caller gets a truthful signal (the old code returned True the moment
             it tapped Connect, masking a failed join)."""
        self._shell("svc", "wifi", "enable")
        # Wi-Fi scanning is gated on Location being ON; without it the settings list is
        # empty and the SSID "isn't in the list". Enabling persists + needs no UI.
        try:
            self._shell("settings", "put", "secure", "location_mode", "3")
        except subprocess.SubprocessError:
            pass
        time.sleep(2)

        if self.current_ssid() == ssid:
            print(f"[wifi] already associated to {ssid!r}", flush=True)
            return True
        # A saved network reconnects on its own once the radio is up.
        if self._wait_assoc(ssid, 12.0):
            print(f"[wifi] auto-reconnected to saved {ssid!r}", flush=True)
            return True

        self._join_wifi_ui(ssid, psk)
        if self._wait_assoc(ssid, verify_timeout):
            print(f"[wifi] associated to {ssid!r}", flush=True)
            return True
        print(
            f"[wifi] NOT associated to {ssid!r} after the Settings join "
            f"(current={self.current_ssid()!r})",
            file=sys.stderr,
        )
        return False

    def _join_wifi_ui(self, ssid: str, psk: str) -> None:
        """Drive the Wi-Fi settings list: open it (which kicks a scan), find the SSID
        (scrolling to reveal it), tap it, type the PSK if prompted, Connect, then leave
        the settings screen. Best-effort — association is verified by the caller."""
        self._shell("am", "start", "-a", "android.settings.WIFI_SETTINGS")
        time.sleep(4)
        net = None
        for _ in range(8):
            net = find_network_row(self.dump(), ssid)
            if net:
                break
            # scroll the AP list down to reveal weaker / below-the-fold networks
            self._shell("input", "swipe", "360", "1300", "360", "500", "300")
            time.sleep(1.5)
        if not net:
            print(f"[wifi] {ssid!r} not in the network list", file=sys.stderr)
            self._shell("input", "keyevent", "3")  # HOME, off the settings screen
            return
        self.tap_node(net)
        time.sleep(2)
        pw = self.find(cls="EditText", password=True)
        if pw:  # a fresh (unsaved) network prompts for the password
            self.tap_node(pw)
            self.type_text(psk)
            conn = next(
                (
                    n
                    for n in self.dump()
                    if n.clickable and n.text.strip().lower() in ("connect", "join")
                ),
                None,
            )
            if conn:
                self.tap_node(conn)
        self._shell("input", "keyevent", "3")  # HOME, off the settings screen
        time.sleep(2)

    def accept_cert(self, host: str) -> bool:
        """Trust the device's self-signed cert: visit its https origin and tap through
        Chrome's interstitial (Advanced -> Proceed). The per-host exception then covers
        the app's cross-origin wss to the same host (the device serves a one-shot cert
        landing page at https://<host>/). Returns True once Proceed is tapped or the
        landing page is already showing."""
        browser = os.environ.get(
            "HITL_ANDROID_BROWSER",
            "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher",
        )
        self._shell(
            "am",
            "start",
            "-n",
            browser,
            "-a",
            "android.intent.action.VIEW",
            "-d",
            f"https://{host}/",
        )
        time.sleep(8)
        # Already trusted? the landing page says "Certificate accepted".
        if any("accepted" in n.text.lower() for n in self.dump()):
            return True

        # Chrome's interstitial renders "Advanced" then a "Proceed to <host> (unsafe)"
        # LINK. uiautomator does NOT mark either as clickable=true (they're spans in a
        # WebView), so match by TEXT and tap the node center. Expand Advanced only if the
        # Proceed link isn't already showing (the interstitial may open expanded).
        def by_text(prefix: str):
            return next((n for n in self.dump() if n.text.strip().lower().startswith(prefix)), None)

        for _ in range(5):
            if by_text("proceed"):
                break
            adv = by_text("advanced")
            if adv and "hide" not in adv.text.lower():
                self.tap_node(adv)
            time.sleep(2)
        proc = by_text("proceed")
        if not proc:
            print("[cert] no 'Proceed' link on the interstitial", file=sys.stderr)
            return False
        self.tap_node(proc)
        time.sleep(5)
        return True

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

    def _focused_activity(self) -> str:
        """The resumed/focused window's component (lowercased), best-effort — used to
        tell whether Chrome's first-run flow is still on screen."""
        out = self._shell("dumpsys", "window", capture=True, timeout=15)
        m = re.search(r"mCurrentFocus=\S+\s+\S+\s+([^\s}]+)", out)
        if m:
            return m.group(1).lower()
        m = re.search(r"mFocusedApp=\S+\s+\S+\s+([^\s}]+)", out)
        return m.group(1).lower() if m else ""

    def dismiss_chrome_first_run(self, rounds: int = 12) -> bool:
        """Clear Chrome's welcome / Terms-of-Service / sign-in / sync / notification
        walls so the launched app URL actually loads (a debloated phone shows them on
        the first run, and the tab stays behind them → the app never connects back and
        wait_ready times out). Taps the right button each round (accept ToS, decline
        sign-in, deny notifications) until nothing first-run-ish is on screen. Robust to
        their presence or absence. Returns True if it dismissed anything."""
        dismissed = False
        for _ in range(rounds):
            nodes = self.dump()
            btn = find_first_run_button(nodes)
            if btn is None:
                foc = self._focused_activity()
                # Still inside a Chrome first-run activity with no actionable button yet
                # (mid-animation) — wait a beat and re-check; otherwise we're done.
                if any(k in foc for k in ("firstrun", "signin", "tos", "searchactivity")):
                    time.sleep(1.5)
                    continue
                return dismissed
            label = (btn.text or btn.desc).strip()
            self.tap_node(btn)
            print(f"[chrome] dismissed first-run wall: {label!r}", flush=True)
            dismissed = True
            time.sleep(1.5)
        return dismissed

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
    # The default mode is the full Web-Bluetooth provisioning flow (back-compat); the
    # `join-wifi` / `accept-cert` modes expose the two other adb-UI steps the android
    # CI orchestrator drives in-env before phone_e2e (android_journeys.py) — the phone
    # has to be on the C6's network and trust its self-signed cert first.
    ap.add_argument(
        "--mode",
        choices=["provision", "join-wifi", "accept-cert", "dismiss-chrome"],
        default="provision",
    )
    ap.add_argument("--serial", default=os.environ.get("HITL_ANDROID_SERIAL", ""))
    ap.add_argument("--ssid", default="")
    ap.add_argument("--password", default="")
    ap.add_argument(
        "--name-match",
        default=os.environ.get("HITL_DUT_BLE_NAME", ""),
        help="fragment identifying the DUT in the chooser (e.g. E2F5EF / 'Led Widget CE0824')",
    )
    ap.add_argument("--host", default="", help="device host (accept-cert mode): https://<host>/")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--shot", default="", help="write a screenshot here at the end")
    args = ap.parse_args()
    p = AndroidBleProvisioner(serial=args.serial)

    if args.mode == "join-wifi":
        if not args.ssid:
            ap.error("--ssid is required for --mode join-wifi")
        ok = p.join_wifi(args.ssid, args.password)
        if args.shot:
            p.screenshot(args.shot)
        print("[wifi] JOIN", "OK" if ok else "FAILED", flush=True)
        return 0 if ok else 1

    if args.mode == "dismiss-chrome":
        did = p.dismiss_chrome_first_run()
        if args.shot:
            p.screenshot(args.shot)
        print("[chrome] FIRST-RUN", "DISMISSED" if did else "CLEAR", flush=True)
        return 0

    if args.mode == "accept-cert":
        if not args.host:
            ap.error("--host is required for --mode accept-cert")
        ok = p.accept_cert(args.host)
        if args.shot:
            p.screenshot(args.shot)
        print("[cert] ACCEPT", "OK" if ok else "FAILED", flush=True)
        return 0 if ok else 1

    # provision (default)
    if not args.ssid or not args.name_match:
        ap.error("--ssid and --name-match are required for --mode provision")
    ok = p.provision(args.ssid, args.password, args.name_match, timeout=args.timeout)
    if args.shot:
        p.screenshot(args.shot)
    print("[ble-ui] PROVISION", "OK" if ok else "FAILED", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
