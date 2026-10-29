#!/usr/bin/env python3
"""Splanc Bridge Flasher sidecar: the process the Electron window talks to.

Adapted from td-deploy Studio's sidecar (app/sidecar.py, MIT): newline-delimited
JSON, one command per line on stdin, events on stdout.

Commands:
  {"cmd":"release"}                     pi-bridge-v* releases -> "release"
  {"cmd":"list_disks"}                  removable disks -> "disks"
  {"cmd":"validate","form":{...}}       -> "validation" {errors:{field:msg}, hostname}
  {"cmd":"flash","board":"pi5","tag":"pi-bridge-v1.1.0","disk_id":"/dev/rdisk4",
       "form":{...},"local_image":null} download/verify/unpack + write + settings
                                        (no tag: the default release)
  {"cmd":"cancel"}                      stop a flash before the write starts
  form = {ssid, psk, hidden, ethernet_only, country, device_name, relay, ssh_key}

Events:
  {"type":"ready","version":..}
  {"type":"release","release":{tag,version,prerelease,boards:[{board,board_name,size,..}]}|null,
       "releases":[release, ..] (newest first; "release" is the default pick),"error":..}
  {"type":"disks","disks":[{id,name,size,size_gb,bus,large}]}
  {"type":"validation","errors":{..},"hostname":"splanc-bridge"}
  {"type":"progress","stage":"download|verify|unpack|write|check|configure",
       "frac":0..1,"overall":0..1,"message":".."}
  {"type":"flash_done","disk":{..},"hostname":"..","board":"..","version":"1.1.0"|null}
  {"type":"flash_error","message":".."}
  {"type":"log","line":".."}

Re-entry: `sidecar --raw-write <image> <device> <progress_file> [--no-verify]` is
the privileged raw-write worker (splanc_flasher.rawwrite): the frozen binary
writes the card as root without shipping a separate interpreter.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_out = threading.Lock()

# Weights of each stage in the single overall progress bar.
STAGES = [
    ("download", 0.34),
    ("verify", 0.04),
    ("unpack", 0.10),
    ("write", 0.36),
    ("check", 0.13),
    ("configure", 0.03),
]


def overall(stage: str, frac: float) -> float:
    names = [s for s, _ in STAGES]
    if stage not in names:
        return 0.0
    i = names.index(stage)
    done = sum(w for _, w in STAGES[:i])
    total = sum(w for _, w in STAGES)
    return min(1.0, (done + STAGES[i][1] * max(0.0, min(1.0, frac))) / total)


def emit(obj: dict) -> None:
    with _out:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def app_version() -> str:
    for base in (getattr(sys, "_MEIPASS", None), os.path.dirname(os.path.abspath(__file__))):
        if not base:
            continue
        try:
            with open(os.path.join(base, "version.json")) as f:
                return json.load(f).get("version", "dev")
        except (OSError, ValueError):
            continue
    return "dev"


def validate(form: dict) -> tuple:
    """(errors, settings kwargs for bootfiles.write_boot_config, hostname)."""
    from splanc_flasher import bootfiles as bf

    errors = {}
    settings = {}
    if not form.get("ethernet_only"):
        ssid = form.get("ssid") or ""
        psk = form.get("psk") or ""
        try:
            bf.check_ssid(ssid)
        except bf.InvalidSetting as e:
            errors["ssid"] = str(e)
        try:
            bf.check_psk(psk)
        except bf.InvalidSetting as e:
            errors["psk"] = str(e)
        settings["wifi"] = bf.Wifi(ssid=ssid, psk=psk, hidden=bool(form.get("hidden")))
    if form.get("country"):
        try:
            settings["country"] = bf.check_country(form["country"])
        except bf.InvalidSetting as e:
            errors["country"] = str(e)
    hostname = "splanc-bridge"
    name = (form.get("device_name") or "").strip()
    if name:
        h = bf.slug_hostname(name)
        if h is None:
            errors["device_name"] = "Use letters and digits in the name (for example: Living Room)."
        else:
            hostname = h
            settings["hostname"] = h
    if form.get("relay"):
        try:
            settings["relay"] = bf.check_relay(form["relay"])
        except bf.InvalidSetting as e:
            errors["relay"] = str(e)
    if (form.get("ssh_key") or "").strip():
        try:
            settings["ssh_keys"] = bf.ssh_key_lines(form["ssh_key"])
        except bf.InvalidSetting as e:
            errors["ssh_key"] = str(e)
    return errors, settings, hostname


class Sidecar:
    def __init__(self) -> None:
        self.release = None  # the default pick
        self.releases = []
        self.cancel = threading.Event()
        self.busy = False

    def _bg(self, fn, *args) -> None:
        threading.Thread(target=fn, args=args, daemon=True).start()

    def get_release(self) -> None:
        from splanc_flasher import releases

        try:
            self.releases = releases.list_releases()
            self.release = releases.default_release(self.releases)
            emit(
                {
                    "type": "release",
                    "release": self.release.to_dict() if self.release else None,
                    "releases": [r.to_dict() for r in self.releases],
                }
            )
        except Exception as e:  # noqa: BLE001 - offline etc.: the UI shows it + retry
            emit(
                {
                    "type": "release",
                    "release": None,
                    "releases": [],
                    "error": f"Couldn't reach GitHub: {e}",
                }
            )

    def pick_release(self, tag):
        """The release the user chose (by tag), else the default one."""
        from splanc_flasher import releases

        if not self.releases:
            self.releases = releases.list_releases()
            self.release = releases.default_release(self.releases)
        if tag:
            hit = next((r for r in self.releases if r.tag == tag), None)
            if hit is None:
                raise ValueError(f"Splanc bridge release {tag} isn't published (any more).")
            return hit
        return self.release

    def list_disks(self) -> None:
        from splanc_flasher import disks

        try:
            emit({"type": "disks", "disks": [d.to_dict() for d in disks.list_disks()]})
        except Exception as e:  # noqa: BLE001
            emit({"type": "disks", "disks": [], "error": str(e)})

    def flash(self, msg: dict) -> None:
        from splanc_flasher import flash, releases

        def progress(stage, frac, message):
            emit(
                {
                    "type": "progress",
                    "stage": stage,
                    "frac": frac,
                    "overall": overall(stage, frac),
                    "message": message,
                }
            )

        try:
            errors, settings, hostname = validate(msg.get("form") or {})
            if errors:
                raise ValueError(next(iter(errors.values())))
            local = msg.get("local_image")
            version = None
            if local:
                image = releases.local_image(local, progress)
            else:
                board = msg.get("board")
                rel = self.pick_release(msg.get("tag"))
                if rel is None or board not in rel.images:
                    which = f" {rel.version}" if rel else ""
                    raise ValueError(f"No published Splanc bridge{which} image for {board}.")
                version = rel.version
                image = releases.fetch_image(
                    rel.images[board], on_progress=progress, cancelled=self.cancel.is_set
                )
            if self.cancel.is_set():
                raise InterruptedError("cancelled")
            disk = flash.flash(
                image,
                msg.get("disk_id") or "",
                settings,
                on_progress=progress,
                log=lambda line: emit({"type": "log", "line": line}),
            )
            emit(
                {
                    "type": "flash_done",
                    "disk": disk.to_dict(),
                    "hostname": hostname,
                    "board": msg.get("board"),
                    "version": version,
                }
            )
        except InterruptedError:
            emit({"type": "flash_error", "message": "Cancelled.", "cancelled": True})
        except Exception as e:  # noqa: BLE001 - surface to the UI
            emit({"type": "log", "line": traceback.format_exc()})
            emit({"type": "flash_error", "message": str(e)})
        finally:
            self.busy = False

    def handle(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "release":
            self._bg(self.get_release)
        elif cmd == "list_disks":
            self._bg(self.list_disks)
        elif cmd == "validate":
            errors, _settings, hostname = validate(msg.get("form") or {})
            emit({"type": "validation", "errors": errors, "hostname": hostname})
        elif cmd == "flash":
            if self.busy:
                emit({"type": "flash_error", "message": "A card is already being written."})
                return
            self.busy = True
            self.cancel.clear()
            self._bg(self.flash, msg)
        elif cmd == "cancel":
            self.cancel.set()
        elif cmd == "ping":
            emit({"type": "pong"})
        else:
            emit({"type": "log", "line": f"unknown command {cmd!r}"})


def main() -> int:
    # Privileged re-entry: act as the raw writer and nothing else.
    if len(sys.argv) >= 2 and sys.argv[1] == "--raw-write":
        from splanc_flasher import rawwrite

        return rawwrite.main(sys.argv[2:])
    sc = Sidecar()
    emit({"type": "ready", "version": app_version()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            sc.handle(json.loads(line))
        except Exception as e:  # noqa: BLE001
            emit({"type": "log", "line": f"bad command: {e}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
