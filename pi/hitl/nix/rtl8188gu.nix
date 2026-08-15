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
# NOTE: this is an old Realtek vendor driver; building against a modern kernel
# (the rig is on 6.12) may need source fixups. Patches go in `patches`/`postPatch`
# below as compile errors surface (can't be built in the dev container — no RPi
# kernel build tree there).
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

  nativeBuildInputs = kernel.moduleBuildDependencies;

  hardeningDisable = [ "pic" "format" ];

  # The Makefile's CONFIG_PLATFORM_ARM64 block hardcodes Android-SDK KSRC/CROSS
  # paths; command-line assignments override those `:=` defaults. Build natively
  # (aarch64 builder → aarch64 target), so CROSS_COMPILE is empty.
  makeFlags = kernel.makeFlags ++ [
    "ARCH=${stdenv.hostPlatform.linuxArch}"
    "CROSS_COMPILE="
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
