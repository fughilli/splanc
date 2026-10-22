"""Sign a release's app for over-the-air updates (docs/design/ota.md "Signing").

  OTA_SIGNING_KEY=<hex> python3 tools/ota_release.py \\
      --bundle bazel-bin/firmware/player_app/esp32c6_ota_flashbundle.tar \\
      --version 1.9.0 --signer bazel-bin/firmware/ota/ota_sign \\
      --pubkey firmware/ota/keys/release.pub --out-dir _assets

Writes, for release X.Y.Z:
  esp32c6-netstack-X.Y.Z.ota  the signed package (108-byte manifest || app image),
                              what update_firmware / "Update over Wi-Fi" stream;
  esp32c6-ota-X.Y.Z.tar       the OTA-layout USB bundle (loader + app + migration
                              hints) with the same package inside, so the web app's
                              Flash screen can update over USB or Wi-Fi from one asset.

Refuses to sign when the key isn't the one whose public half is committed
(keys/release.pub): a release signed with any other key would be refused by every
loader in the field. Stdlib only; the signing itself is //firmware/ota:ota_sign.
"""

import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile


def read_pub(path):
    lines = [ln.strip() for ln in open(path) if ln.strip() and not ln.strip().startswith("#")]
    return "".join(lines).lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--signer", required=True)
    ap.add_argument("--pubkey", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--key-env", default="OTA_SIGNING_KEY")
    # The release key is key id 0; raise --security-version when a release fixes a
    # security hole (docs/design/ota.md "Anti-rollback"): loaders then refuse older ones.
    ap.add_argument("--security-version", default="0")
    # The newest signed key-epoch record (firmware/ota/keys/epoch.bin), shipped as
    # key-epoch.bin so every client sends it with ota_begin (docs/design/ota.md).
    ap.add_argument("--key-epoch", default="")
    a = ap.parse_args()

    if not os.environ.get(a.key_env):
        sys.exit(f'ota_release: ${a.key_env} is not set — see docs/design/ota.md "Signing"')
    want = read_pub(a.pubkey)
    if want == "unset":
        sys.exit(f"ota_release: {a.pubkey} is UNSET — commit the release public key first")
    got = (
        subprocess.run(
            [a.signer, "pubkey", "--key-env", a.key_env], capture_output=True, text=True, check=True
        )
        .stdout.strip()
        .lower()
    )
    if got != want:
        sys.exit(f"ota_release: ${a.key_env} is not the key whose public half is {a.pubkey}")

    with tarfile.open(a.bundle) as t:
        members = {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
    manifest = json.loads(members["flash.json"])
    app_off = int(manifest["ota"]["app_offset"], 16)
    app = [i for i in manifest["images"] if int(i["offset"], 16) == app_off]
    if len(app) != 1:
        sys.exit("ota_release: the bundle has no app image at the app offset")
    image = members[app[0]["file"]]

    os.makedirs(a.out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        img_path = os.path.join(d, "app.bin")
        man_path = os.path.join(d, "app.manifest")
        open(img_path, "wb").write(image)
        out = subprocess.run(
            [
                a.signer,
                "sign",
                "--key-env",
                a.key_env,
                "--version",
                a.version,
                "--key-id",
                "0",
                "--security-version",
                a.security_version,
                "--in",
                img_path,
                "--out",
                man_path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        print(out.stdout.strip())
        subprocess.run(
            [a.signer, "verify", "--pubkey", want, "--manifest", man_path, "--in", img_path],
            check=True,
        )
        package = open(man_path, "rb").read() + image

    pkg_name = f"esp32c6-netstack-{a.version}.ota"
    open(os.path.join(a.out_dir, pkg_name), "wb").write(package)

    manifest["ota"]["package"] = "esp32c6-netstack.ota"
    members["flash.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    members["esp32c6-netstack.ota"] = package
    extra = ["esp32c6-netstack.ota"]
    if a.key_epoch and os.path.exists(a.key_epoch):
        epoch = open(a.key_epoch, "rb").read()
        if len(epoch) != 80:
            sys.exit(f"ota_release: {a.key_epoch} is not an 80-byte key-epoch record")
        members["key-epoch.bin"] = epoch
        extra.append("key-epoch.bin")
        open(os.path.join(a.out_dir, "key-epoch.bin"), "wb").write(epoch)
    tar_path = os.path.join(a.out_dir, f"esp32c6-ota-{a.version}.tar")
    order = ["flash.json"] + [i["file"] for i in manifest["images"]] + extra
    with tarfile.open(tar_path, "w") as t:
        for name in order:
            data = members[name]
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    print(f"wrote {pkg_name} ({len(package)} B) and {os.path.basename(tar_path)}")


if __name__ == "__main__":
    main()
