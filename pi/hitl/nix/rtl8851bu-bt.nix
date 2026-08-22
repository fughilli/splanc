# Bluetooth firmware for the RTL8851BU USB combo dongle's BT half (btusb).
#
# The dongle's WiFi half (rtw89) is handled by rtl8851bu.nix; its BT half is a
# standard in-tree `btusb` device, but the kernel's btrtl init needs the Realtek
# firmware blob `rtl_bt/rtl8851bu_fw.bin` — which the rig's trimmed
# nixos-raspberrypi firmware set does NOT ship (its /lib/firmware has no rtl_bt/
# dir at all), so btusb registers hci but leaves it DOWN with
# "Direct firmware load for rtl_bt/rtl8851bu_fw.bin failed". This derivation
# installs just that one blob under lib/firmware/rtl_bt so hardware.firmware can
# wire it in — no 500 MB full linux-firmware closure on the deploy.
#
# The blob is vendored (nix/firmware/rtl_bt/rtl8851bu_fw.bin, 49760 B, from
# upstream linux-firmware) rather than fetched, so the build is offline and
# byte-reproducible. There is no rtl8851bu_config.bin for this chip; btrtl's
# attempt to load it fails with -2, which is non-fatal (the fw loads regardless).
{ lib, stdenvNoCC }:

stdenvNoCC.mkDerivation {
  pname = "rtl8851bu-bt-firmware";
  version = "linux-firmware-vendored";

  src = ./firmware;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dvm644 rtl_bt/rtl8851bu_fw.bin \
      "$out/lib/firmware/rtl_bt/rtl8851bu_fw.bin"
    runHook postInstall
  '';

  meta = with lib; {
    description = "Realtek RTL8851BU Bluetooth (btusb/btrtl) firmware blob";
    homepage = "https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git";
    # linux-firmware redistributable-binary license (Realtek terms in WHENCE).
    license = licenses.unfreeRedistributableFirmware;
    platforms = platforms.linux;
  };
}
