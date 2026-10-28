"""VM test helper: the Improv path's NetworkManager side, against the real nmcli.

The QEMU VM has no Bluetooth adapter and no WiFi device, so this drives
splanc_image.improv / wifi_profiles directly (nix/vm-test.nix):

    improv_vm.py store <expect.json>   store a network as the Improv path does
                                       (Joiner's plan + write + `nmcli connection
                                       load`): the tricky SSID with a new PSK
                                       (dedupe: replaces splanc-wifi in place) and a
                                       second network (added as splanc-wifi-2)
    improv_vm.py join <ssid> <psk>     a full Joiner.join: real scan/load/up argv;
                                       with no WiFi device the join fails, so it
                                       must roll back and print "None"
"""

import asyncio
import json
import subprocess
import sys

from splanc_flasher import bootfiles as bf
from splanc_image import improv, wifi_profiles


def store(expect_path: str) -> None:
    expect = json.load(open(expect_path, encoding="utf-8"))
    for wifi in (
        bf.Wifi(expect["ssid"], "n3w " + expect["psk"]),
        bf.Wifi("Venue Wi-Fi", "venue-pass"),
    ):
        plan = wifi_profiles.plan(wifi)
        wifi_profiles.write(plan)
        subprocess.run(["nmcli", "connection", "load", plan.path], check=True)
        print(plan.conn_id, plan.path, "replaced" if plan.previous is not None else "added")


def join(ssid: str, psk: str) -> None:
    print(asyncio.run(improv.Joiner(log=lambda m: print(m, file=sys.stderr)).join(ssid, psk)))


if __name__ == "__main__":
    {"store": lambda: store(sys.argv[2]), "join": lambda: join(sys.argv[2], sys.argv[3])}[
        sys.argv[1]
    ]()
