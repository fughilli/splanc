# Out-of-tree Realtek RTL8851BU (WiFi 6 + BT combo) driver for the logic-analyzer
# rig's dedicated USB AP adapter. The dongle enumerates as 0bda:1a2b (CD-ROM mode)
# → 0bda:b851 (802.11ax) after usb_modeswitch; the WiFi half is an RTL8851BU. The
# Pi 3's onboard brcmfmac can't reliably host an AP, so this USB radio is the
# dedicated AP; see nix/hitl-app.nix.
#
# This is the modern mainline rtw89 driver family (mac80211-based, proper hostapd
# AP support), packaged from morrownr/rtw89 which backports 8851BU-USB to kernels
# 6.6+. The rig runs 6.12.87, so the in-tree rtw89 (which only gained 8851BU USB in
# 6.14+) is too old — hence this out-of-tree build. Because it's a clean kbuild
# delegation (make -C $KDIR M=$PWD modules), no source patching is needed on 6.12,
# unlike the old vendor drivers.
#
# Built against the rig's kernel via boot.extraModulePackages (a post-boot module,
# not initrd), so it lands in the deploy_live layer — no SD reimage. The USB adapter
# binds module `rtw89_8851bu_git` (usb id 0bda:b851, see rtw8851bu.c id table); udev
# autoloads it by modalias. This derivation also ships the WiFi firmware
# (rtw8851b_fw-1.bin) under lib/firmware/rtw89 — wire it into hardware.firmware.
{ lib, stdenv, fetchFromGitHub, kernel }:

stdenv.mkDerivation {
  pname = "rtl8851bu";
  version = "unstable-2026-08-16-${kernel.version}";

  src = fetchFromGitHub {
    owner = "morrownr";
    repo = "rtw89";
    rev = "e2be1a0e049d2d3a9c2f47a88ba6f1a4f713dfea";
    hash = "sha256-k9UtFCm8TvnJAidHOTsGfg0rkIOy0CvL8OsP6uiulEk=";
  };

  nativeBuildInputs = kernel.moduleBuildDependencies;

  hardeningDisable = [ "pic" "format" ];

  # Standard out-of-tree kbuild: the repo Makefile's default `modules` target runs
  # `make -C $KDIR M=$PWD modules`. Command-line make variables (ARCH/CROSS_COMPILE/
  # CC/KDIR/KVER) propagate to that sub-make, so we point KDIR at the kernel's build
  # tree and build natively (aarch64 builder → aarch64 target, CROSS_COMPILE empty).
  # kernel.makeFlags carries kernel-build-only flags (O=…, --eval=undefine …) that
  # confuse out-of-tree Makefiles, so pass just what the build needs.
  makeFlags = [
    "ARCH=${stdenv.hostPlatform.linuxArch}"
    "CROSS_COMPILE="
    "CC=${kernel.stdenv.cc}/bin/cc"
    "KVER=${kernel.modDirVersion}"
    "KDIR=${kernel.dev}/lib/modules/${kernel.modDirVersion}/build"
  ];

  installPhase = ''
    runHook preInstall
    moddir="$out/lib/modules/${kernel.modDirVersion}/kernel/drivers/net/wireless/realtek/rtw89"
    install -d "$moddir"
    for ko in *.ko; do
      install -Dvm644 "$ko" "$moddir/$ko"
    done
    # WiFi firmware shipped in-repo; the driver loads it from /lib/firmware/rtw89.
    install -Dvm644 -t "$out/lib/firmware/rtw89" firmware/rtw8851b_fw-1.bin
    runHook postInstall
  '';

  meta = with lib; {
    description = "Realtek RTL8851BU (rtw89) USB WiFi 6 driver + firmware (out-of-tree)";
    homepage = "https://github.com/morrownr/rtw89";
    license = licenses.gpl2Only;
    platforms = platforms.linux;
    broken = kernel.kernelOlder "6.6";
  };
}
