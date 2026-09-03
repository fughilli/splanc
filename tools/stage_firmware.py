#!/usr/bin/env python3
"""Stage firmware flash bundle(s) into the web publish tree for in-browser
flashing (FUG-60).

Each `--image ID=BUNDLE.tar` is an esptool flash bundle (flash.json + bins, from
//tools:mk_flashbundle). We extract it verbatim to `<out>/<ID>/` and write a
top-level `<out>/manifest.json` INDEX the webapp fetches to learn which images
this build bundles, at what revision, and which flasher family each needs. The
per-image flash.json (offsets/params) is served untouched — the browser flasher
writes exactly what `bazel run …:flash_<id>` would.

  stage_firmware.py --out DIR [--revision R] [--commit SHA] [--fw-version V] \
      [--built-at ISO] --image esp32c6=path/to/esp32c6_flashbundle.tar

The webapp expects, under DIR:
  manifest.json              {revision, builtAt, version?, commit?,
                              entries:[{id,label,chip,family,manifest}]}
  <ID>/flash.json            the bundle's manifest (chip, flash params, images[])
  <ID>/<image>.bin           each referenced image, flat by basename

Stdlib only, so it runs from the deploy/serve scripts on any host with python3.
"""
import argparse
import json
import os
import sys
import tarfile

# Map an esptool chip id to the webapp flasher family (see web/src/flash/usb.ts).
# Extend here in lockstep with a new Flasher backend.
_FAMILY_BY_PREFIX = (
    ("esp32", "esp"),
    ("esp8266", "esp"),
    ("rp2", "rp2"),
)


def _family_for(chip: str) -> str:
    c = chip.lower()
    for prefix, family in _FAMILY_BY_PREFIX:
        if c.startswith(prefix):
            return family
    sys.exit("stage_firmware: no flasher family known for chip %r" % chip)


# Prettier display names for known chips (else the raw id, upper-cased).
_CHIP_NAMES = {
    "esp32c6": "ESP32-C6",
    "esp32c3": "ESP32-C3",
    "esp32s3": "ESP32-S3",
    "esp32s2": "ESP32-S2",
    "esp32h2": "ESP32-H2",
    "esp32": "ESP32",
}


def _label_for(chip: str, image_id: str = "") -> str:
    base = "LED Mapper player — %s" % _CHIP_NAMES.get(chip.lower(), chip.upper())
    # Distinguish variants that share a chip (e.g. esp32c6 vs esp32c6_netstack):
    # append whatever the image id carries beyond the bare chip name.
    suffix = ""
    if image_id and image_id.lower().startswith(chip.lower()):
        suffix = image_id[len(chip) :].lstrip("_-")
    elif image_id and image_id.lower() != chip.lower():
        suffix = image_id
    return "%s (%s)" % (base, suffix) if suffix else base


def _extract_bundle(tar_path: str, dest: str) -> dict:
    """Extract a flash bundle to dest/, returning its parsed flash.json."""
    os.makedirs(dest, exist_ok=True)
    manifest = None
    with tarfile.open(tar_path, "r") as tar:
        for member in tar.getmembers():
            # Bundles are flat (flash.json + basename bins); reject any path that
            # would escape dest (defensive, though we build these bundles).
            name = member.name
            if os.path.isabs(name) or ".." in name.split("/"):
                sys.exit("stage_firmware: unsafe member %r in %s" % (name, tar_path))
            data = tar.extractfile(member)
            if data is None:
                continue
            blob = data.read()
            with open(os.path.join(dest, name), "wb") as f:
                f.write(blob)
            if name == "flash.json":
                manifest = json.loads(blob)
    if manifest is None:
        sys.exit("stage_firmware: %s has no flash.json" % tar_path)
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="firmware tree output directory")
    ap.add_argument("--revision", default="", help="git short SHA the images were built at")
    ap.add_argument("--commit", default="", help="full git commit the images were built at")
    ap.add_argument(
        "--fw-version",
        default="",
        help="firmware release version (nearest firmware-v* tag, e.g. 1.2.0)",
    )
    ap.add_argument("--built-at", default="", help="ISO build timestamp")
    ap.add_argument(
        "--image",
        action="append",
        default=[],
        metavar="ID=BUNDLE.tar",
        help="a flash bundle to stage under <out>/<ID>/ (repeatable)",
    )
    a = ap.parse_args()

    if not a.image:
        sys.exit("stage_firmware: at least one --image is required")

    os.makedirs(a.out, exist_ok=True)
    entries = []
    for spec in a.image:
        if "=" not in spec:
            sys.exit("stage_firmware: --image must be ID=BUNDLE.tar, got %r" % spec)
        image_id, tar_path = spec.split("=", 1)
        flash = _extract_bundle(tar_path, os.path.join(a.out, image_id))
        chip = flash.get("chip")
        if not chip:
            sys.exit("stage_firmware: %s flash.json has no chip" % image_id)
        entries.append(
            {
                "id": image_id,
                "label": _label_for(chip, image_id),
                "chip": chip,
                "family": _family_for(chip),
                "manifest": "flash.json",
            }
        )

    index = {
        "revision": a.revision or None,
        "builtAt": a.built_at or None,
        "entries": entries,
    }
    # A single bundled build shares one version/commit stamp — record it index-level
    # (parseFirmwareIndex applies it to every entry) so the flash sheet can show what
    # the "this build (dev)" source would write, exactly like a release entry.
    if a.fw_version:
        index["version"] = a.fw_version
    if a.commit:
        index["commit"] = a.commit
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        f.write(json.dumps(index, indent=2) + "\n")

    sys.stderr.write(
        "stage_firmware: wrote %s (%d image(s): %s)\n"
        % (a.out, len(entries), ", ".join(e["id"] for e in entries))
    )


if __name__ == "__main__":
    main()
