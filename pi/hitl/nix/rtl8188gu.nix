# Out-of-tree Realtek RTL8188GU (RTL8710BU) WiFi driver, packaged as a kernel
# module for the logic-analyzer rig's dedicated USB AP adapter (a TP-Link
# TL-WN725N-style dongle, 0bda:1a2b in CD-ROM mode → 0bda:b711 after modeswitch).
# The Pi 3's onboard brcmfmac can't reliably host an AP, so this USB radio is the
# dedicated AP; see nix/hitl-app.nix.
#
# Built against the rig's kernel via boot.extraModulePackages (a post-boot module,
# not initrd), so it lands in the deploy_live layer — no SD reimage. The module is
# `8188gu`; usb_modeswitch flips the dongle and udev autoloads this on the WiFi PID.
#
# This is an old (~6.1-era) Realtek vendor driver; rtl8188gu-6.12.patch ports it to
# the rig's 6.12 kernel (cfg80211 6.7 MLO signature changes + removed APIs — see the
# patch comment). Verified by building the derivation against a generic linux 6.12
# (same mainline API as the RPi 6.12.87); the module modalias binds 0bda:b711 (the
# post-modeswitch WiFi PID), so udev autoloads it.
{ lib, stdenv, fetchFromGitHub, kernel }:

stdenv.mkDerivation {
  pname = "rtl8188gu";
  # Upstream tags the driver 1.0.1; pin the exact commit for reproducibility.
  version = "1.0.1-unstable-2024";

  src = fetchFromGitHub {
    owner = "wandercn";
    repo = "RTL8188GU";
    rev = "f9944c51911d851bb214a56ea0c4fc11059f6bf8";
    hash = "sha256-HVwuofQqTpo6GMtw8Orx3YsfEAfDIbYfejlDbJh3ZU0=";
  };

  # The driver Makefile lives in the versioned subdir.
  sourceRoot = "source/8188gu-1.0.1";

  # Port the ~6.1-era Realtek vendor driver to the rig's 6.12 kernel. Developed by
  # building against a generic linux 6.12 (same mainline API as the RPi 6.12.87):
  #   - cfg80211 6.7 MLO refactor: add_key/get_key/del_key/set_default_key and
  #     stop_ap gained a link_id arg; change_beacon takes cfg80211_ap_update;
  #     ch_switch_notify gained link_id; wdev->current_bss → wdev->connected;
  #     cfg80211_roam_info.bssid → .links[0].bssid.
  #   - removed APIs: mm_segment_t/set_fs (guard the decls), prandom_u32 →
  #     get_random_u32, complete_and_exit → kthread_complete_and_exit, PDE_DATA →
  #     pde_data, netif_napi_add(+weight) → netif_napi_add_weight, usb_driver.drvwrap.
  #   - gcc10+ (-fno-common): `extern __inline` in ieee80211.h → `static __inline`.
  patches = [ ./rtl8188gu-6.12.patch ];

  nativeBuildInputs = kernel.moduleBuildDependencies;

  hardeningDisable = [ "pic" "format" ];

  # The Makefile's CONFIG_PLATFORM_ARM64 block hardcodes Android-SDK KSRC/CROSS
  # paths; command-line assignments override those `:=` defaults. Build natively
  # (aarch64 builder → aarch64 target), so CROSS_COMPILE is empty. Don't pass
  # kernel.makeFlags: it carries kernel-build-only flags (O=$(buildRoot),
  # --eval=undefine …) that break this out-of-tree Makefile; pass just the
  # kernel's compiler + the module build (KSRC → make -C $KSRC M=$PWD modules).
  makeFlags = [
    "ARCH=${stdenv.hostPlatform.linuxArch}"
    "CROSS_COMPILE="
    "CC=${kernel.stdenv.cc}/bin/cc"
    "KSRC=${kernel.dev}/lib/modules/${kernel.modDirVersion}/build"
  ];

  installPhase = ''
    runHook preInstall
    install -D 8188gu.ko \
      "$out/lib/modules/${kernel.modDirVersion}/kernel/drivers/net/wireless/realtek/8188gu.ko"
    runHook postInstall
  '';

  meta = with lib; {
    description = "Realtek RTL8188GU/RTL8710BU USB WiFi driver (out-of-tree kernel module)";
    homepage = "https://github.com/wandercn/RTL8188GU";
    license = licenses.gpl2Only;
    platforms = platforms.linux;
    # Old vendor driver; AP-mode capable but may need patches on newer kernels.
    broken = kernel.kernelOlder "4.9";
  };
}
