"""Copy the isolated hero build and its WASM runtime into a static website."""

import argparse
import re
import shutil
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="Website public/scenes/maxa directory")
    parser.add_argument(
        "--runtime", type=Path, required=True, help="Directory with fx-compiler and fx-vm bundles"
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    dist = root / "web/dist"
    html = (dist / "scene.html").read_text()
    assets = re.findall(r'(?:src|href)="\./(assets/[^\"]+)"', html)
    if len(assets) != 1:
        raise ValueError("Build the isolated scene entry before exporting (expected one JS asset)")
    script = (dist / assets[0]).read_text()
    if re.search(r'import[^;]*["\']\./[^"\']+["\']', script):
        raise ValueError("The hero must be self-contained, without app bootstrap imports")
    for bundle in ("fx-compiler", "fx-vm"):
        if not (args.runtime / bundle).is_dir():
            raise ValueError(f"Missing runtime bundle: {bundle}")
    args.destination.mkdir(parents=True, exist_ok=True)
    (args.destination / "assets").mkdir(exist_ok=True)
    # Remove old content-hashed scene assets, only within this owned directory.
    for old in (args.destination / "assets").glob("scene-*.js"):
        old.unlink()
    shutil.copy2(dist / "scene.html", args.destination / "scene.html")
    shutil.copy2(root / "LICENSE", args.destination / "LICENSE")
    for asset in assets:
        shutil.copy2(dist / asset, args.destination / asset)
    for bundle in ("fx-compiler", "fx-vm"):
        shutil.copytree(args.runtime / bundle, args.destination / bundle, dirs_exist_ok=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    (args.destination / "README.md").write_text(
        "# Maxa live scene\n\n"
        "Generated from the Splanc application, using its MapView, firmware VM, "
        "Maxa mesh and prebaked topology. The shader and all 11 control positions "
        "come from `web/src/demo/maxaScene.ts`. Colors are normalized RGB values.\n\n"
        f"Source repository: https://github.com/fughilli/splanc/tree/{commit}\n\n"
        "To refresh after building Splanc:\n\n```sh\n"
        "python3 tools/fixtures/export_hero.py /path/to/splanc.io/public/scenes/maxa "
        "--runtime /path/to/built/wasm/bundles\n```\n\n"
        "The runtime directory must contain matching `fx-compiler` and `fx-vm` "
        "bundles (including their JS, WASM and snippets). The exported hero is "
        "self-contained and does not depend on an app deployment or external server.\n"
    )
    print(f"Exported Maxa hero to {args.destination}")


if __name__ == "__main__":
    main()
