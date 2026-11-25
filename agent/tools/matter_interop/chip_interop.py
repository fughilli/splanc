"""Commission the Splanc Matter bridge with the CHIP SDK's own controller and drive a lamp.

Usage (see README.md): chip_interop.py <interop dir> <PAA trust store dir>
"""

import asyncio
import json
import sys
import tempfile
import time

import chip.CertificateAuthority
import chip.clusters as C
import chip.native
from chip.ChipStack import ChipStack
from chip.setup_payload import SetupPayload

D = sys.argv[1]
PAA = sys.argv[2]


async def main():
    code = json.load(open(f"{D}/code.json"))
    print("bridge says:", code["manual"], code["qr"], "lamps", code["lamps"])
    chip.native.Init()
    stack = ChipStack(
        persistentStoragePath=tempfile.mktemp(suffix=".json"), enableServerInteractions=False
    )
    cam = chip.CertificateAuthority.CertificateAuthorityManager(chipStack=stack)
    cam.LoadAuthoritiesFromStorage()
    ca = cam.NewCertificateAuthority()
    fa = ca.NewFabricAdmin(vendorId=0xFFF1, fabricId=1)
    ctrl = fa.NewController(paaTrustStorePath=PAA)
    n = 0x51
    # The setup PIN from the bridge's own manual code, parsed by the SDK.
    pin = SetupPayload().ParseManualPairingCode(code["manual"]).setup_passcode
    await ctrl.CommissionIP("::1", pin, n)
    print("COMMISSIONED with the bridge's manual code")
    parts = (await ctrl.ReadAttribute(n, [(1, C.Descriptor.Attributes.PartsList)]))[1][
        C.Descriptor
    ][C.Descriptor.Attributes.PartsList]
    print("aggregator parts", parts)
    ep = parts[0]
    lab = (
        await ctrl.ReadAttribute(n, [(ep, C.BridgedDeviceBasicInformation.Attributes.NodeLabel)])
    )[ep][C.BridgedDeviceBasicInformation][C.BridgedDeviceBasicInformation.Attributes.NodeLabel]
    print("lamp label", lab)

    async def onoff():
        r = await ctrl.ReadAttribute(n, [(ep, C.OnOff.Attributes.OnOff)])
        return r[ep][C.OnOff][C.OnOff.Attributes.OnOff]

    print("onOff before", await onoff())
    await ctrl.SendCommand(
        n,
        ep,
        C.LevelControl.Commands.MoveToLevel(
            level=64, transitionTime=0, optionsMask=0, optionsOverride=0
        ),
    )
    time.sleep(1)
    await ctrl.SendCommand(n, ep, C.OnOff.Commands.Off())
    time.sleep(1.5)
    print("onOff after Off", await onoff())
    await ctrl.SendCommand(n, ep, C.OnOff.Commands.On())
    time.sleep(1.5)
    print("onOff after On", await onoff())
    print("lamp saw:", open(f"{D}/lamp.json").read())
    ctrl.Shutdown()
    cam.Shutdown()
    stack.Shutdown()


asyncio.run(main())
