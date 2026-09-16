# Android SDK — emulator + a Google-APIs system image + platform-tools + cmdline-tools —
# for the phone-in-the-loop HITL station's Android lane, from the Bazel-pinned nixpkgs
# (rules_nixpkgs sets `<nixpkgs>` to the 25.05 snapshot in //MODULE.bazel).
#
# The emulator runs on Apple-silicon macOS (Hypervisor.framework), x86_64 Linux, and
# aarch64 Linux (all provided by nixpkgs androidenv). We pick a NATIVE-ABI system image
# so the guest runs at native speed on each host — arm64-v8a on ARM (Apple Silicon Mac /
# arm64 Linux), x86_64 on x86_64. Hardware acceleration still needs the host's hypervisor
# (Hypervisor.framework on macOS, /dev/kvm on Linux); a Linux station without KVM can only
# run it (slowly) in software.
#
# Consumed via rules_nixpkgs `nix_pkg.file` (@android_emulator, attr = "sdk"). The composed
# SDK's `libexec/android-sdk/` tree is what ANDROID_SDK_ROOT points at; the station's
# launcher creates an AVD from the bundled system image and boots the emulator.
let
  pkgs = import <nixpkgs> {
    # The Android SDK components are unfree and license-gated; accept once here so the
    # station build is non-interactive (the license text is Google's standard SDK EULA).
    config.android_sdk.accept_license = true;
    config.allowUnfree = true;
  };
  abi = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64";
  android = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "34" ];
    abiVersions = [ abi ];
    systemImageTypes = [ "google_apis" ];
    includeEmulator = true;
    includeSystemImages = true;
    includeSources = false;
    includeNDK = false;
  };
in
{
  sdk = android.androidsdk;
}
