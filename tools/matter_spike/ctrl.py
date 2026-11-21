"""PoC commissioner: PASE over IP (through the relay) + auto-commission + OnOff/Level.
usage: ctrl.py <ip> <port> [--storage f] [--fake-mdns <self_ip>]"""

import argparse
import asyncio
import os
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("ip")
ap.add_argument("port", type=int)
ap.add_argument("--pin", type=int, default=20202021)
ap.add_argument("--node", type=int, default=0x1234)
ap.add_argument("--storage", default="repl.json")
ap.add_argument(
    "--fake-mdns", default=None, help="advertise the operational record at this IP:port"
)
ap.add_argument("--skip-commission", action="store_true")
a = ap.parse_args()
import chip.CertificateAuthority  # noqa: E402 (after argparse: chip is slow to import)
import chip.clusters as C  # noqa: E402 (after argparse: chip is slow to import)
import chip.FabricAdmin  # noqa: E402 (after argparse: chip is slow to import)
import chip.logging  # noqa: E402 (after argparse: chip is slow to import)
import chip.native  # noqa: E402 (after argparse: chip is slow to import)
from chip.ChipStack import ChipStack  # noqa: E402 (after argparse: chip is slow to import)

chip.native.Init()
stack = ChipStack(persistentStoragePath=a.storage, enableServerInteractions=False)
cam = chip.CertificateAuthority.CertificateAuthorityManager(chipStack=stack)
cam.LoadAuthoritiesFromStorage()
ca = cam.activeCaList[0] if cam.activeCaList else cam.NewCertificateAuthority()
fa = ca.adminList[0] if ca.adminList else ca.NewFabricAdmin(vendorId=0xFFF1, fabricId=1)
paa = os.path.join(
    os.environ.get("ESP_MATTER_PATH", "."),
    "connectedhomeip/connectedhomeip/credentials/development/paa-root-certs",
)
dc = fa.NewController(nodeId=112233, paaTrustStorePath=paa)
zc = None


def fake_mdns(instance):
    # Operational discovery (<CFID>-<NodeId>._matter._tcp) can't cross the routed rig
    # container, so answer it locally with the relay's address.
    global zc
    import socket

    from zeroconf import ServiceInfo, Zeroconf

    ip, port = a.fake_mdns.split(":")
    info = ServiceInfo(
        "_matter._tcp.local.",
        f"{instance}._matter._tcp.local.",
        addresses=[socket.inet_aton(ip)],
        port=int(port),
        properties={"SII": "5000", "SAI": "300"},
        server="relaydut.local.",
    )
    zc = Zeroconf(interfaces=[ip])
    zc.register_service(info, allow_name_change=False)
    print("fake mdns:", instance, "->", a.fake_mdns, flush=True)


if a.fake_mdns:
    # Registered before the asyncio loop starts: python-zeroconf's sync API blocks inside one.
    fake_mdns("%016X-%016X" % (dc.GetCompressedFabricId(), a.node))


async def main():
    t0 = time.time()
    if not a.skip_commission:
        await dc.EstablishPASESessionIP(a.ip, a.pin, a.node, a.port)
        print("PASE ok %.1fs" % (time.time() - t0), flush=True)
        nid = await dc.Commission(a.node)
        print("COMMISSIONED node 0x%x in %.1fs" % (nid, time.time() - t0), flush=True)
    for cmd in (C.OnOff.Commands.On(), C.OnOff.Commands.Off(), C.OnOff.Commands.Toggle()):
        await dc.SendCommand(a.node, 1, cmd)
        r = await dc.ReadAttribute(a.node, [(1, C.OnOff.Attributes.OnOff)])
        print(type(cmd).__name__, "-> OnOff =", r[1][C.OnOff][C.OnOff.Attributes.OnOff], flush=True)
        await asyncio.sleep(1)
    await dc.SendCommand(
        a.node, 1, C.LevelControl.Commands.MoveToLevelWithOnOff(level=64, transitionTime=0)
    )
    r = await dc.ReadAttribute(a.node, [(1, C.LevelControl.Attributes.CurrentLevel)])
    print(
        "MoveToLevel(64) -> CurrentLevel =",
        r[1][C.LevelControl][C.LevelControl.Attributes.CurrentLevel],
        flush=True,
    )
    r = await dc.ReadAttribute(
        a.node,
        [
            (0, C.BasicInformation.Attributes.VendorName),
            (0, C.BasicInformation.Attributes.ProductName),
            (0, C.BasicInformation.Attributes.SoftwareVersionString),
        ],
    )
    print("BasicInformation:", r[0][C.BasicInformation], flush=True)


rc = 0
try:
    asyncio.run(main())
except BaseException:  # report and exit: zeroconf/CHIP threads would keep the process alive
    import traceback

    traceback.print_exc()
    rc = 1
sys.stdout.flush()
sys.stderr.flush()
os._exit(rc)
