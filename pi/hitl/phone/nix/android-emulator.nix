# Android SDK — emulator + a native-ABI Google-APIs system image + cmdline-tools — for the
# phone-in-the-loop HITL station's Android lane, from the Bazel-pinned nixpkgs (rules_nixpkgs
# sets `<nixpkgs>` to the 25.05 snapshot in //MODULE.bazel).
#
# The emulator runs on Apple-silicon macOS (Hypervisor.framework), x86_64 Linux, AND aarch64
# Linux (e.g. Asahi, arm64 cloud). nixpkgs' androidenv manifest only lists the emulator for
# macOS + linux-x86_64, so on aarch64-linux we build a CUSTOM emulator from Google's CI
# artifact (ci.android.com — the canonical arm64-linux emulator source) and patch it exactly
# as nixpkgs' emulator.nix patches the x86_64 one (same buildInputs + autoPatchelf + wrap).
# We pick a native-ABI system image per host so the guest runs at native speed. Hardware
# acceleration still needs the host hypervisor (Hypervisor.framework / /dev/kvm).
#
# Consumed via rules_nixpkgs `nix_pkg.file` (@android_emulator, attr = "sdk"). The composed
# SDK's `libexec/android-sdk/` tree is what ANDROID_SDK_ROOT points at.
let
  pkgs = import <nixpkgs> {
    config.android_sdk.accept_license = true;
    config.allowUnfree = true;
  };
  inherit (pkgs) lib stdenv;

  isAarch64Linux = stdenv.hostPlatform.isLinux && stdenv.hostPlatform.isAarch64;
  abi = if stdenv.hostPlatform.isAarch64 then "arm64-v8a" else "x86_64";

  # cmdline-tools (avdmanager, Java) + the arm64-v8a system image + the platform are
  # arch-agnostic and build on every host; the upstream emulator is included where nixpkgs
  # has it (macOS + linux-x86_64) and EXCLUDED on aarch64-linux (supplied below).
  base = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "34" ];
    abiVersions = [ abi ];
    systemImageTypes = [ "google_apis" ];
    includeEmulator = !isAarch64Linux;
    includeSystemImages = true;
    includeSources = false;
    includeNDK = false;
  };

  # The arm64-linux emulator, from Google's CI (aosp-emu-master-dev) — the only source, since
  # neither nixpkgs' manifest nor dl.google.com ships a linux-aarch64 emulator.
  #
  # PIN MAINTENANCE: set `emulatorBuild` to a CURRENT build from
  #   https://ci.android.com/builds/branches/aosp-emu-master-dev/grid
  # then build once — nix prints the real `got:` hash — and paste it into `outputHash`.
  # Old builds are garbage-collected (the storage object 404s as NoSuchKey), so the build
  # number must be recent. The fetch machinery below is verified working (it scrapes the CI
  # page → resolves the temporary signed storage.googleapis.com URL → downloads → nix pins by
  # OUTPUT hash); only a live build number + its hash need filling in.
  emulatorBuild = "8632828"; # EXAMPLE — purged; replace with a current build id.
  # ci.android.com serves an HTML page whose JS points at a TEMPORARY signed
  # storage.googleapis.com URL (Expires=…&Signature=…) — there is no stable direct URL,
  # so a plain fetchurl can't pin it. A fixed-output derivation is the right tool: it is
  # reproducible by its OUTPUT hash (the artifact's content sha256, which Google embeds in
  # the signed URL's path), while its builder gets network access to resolve the fresh
  # signed URL each build. Bump the build + re-pin outputHash when updating.
  emulatorSrc = stdenv.mkDerivation {
    name = "sdk-repo-linux_aarch64-emulator-${emulatorBuild}.zip";
    nativeBuildInputs = with pkgs; [
      cacert
      curl
      gnugrep
      gnused
    ];
    outputHashMode = "flat";
    outputHash = lib.fakeHash; # replace with the `got:` hash after pinning a current build.
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    buildCommand = ''
      page="$(curl -sL -A 'Mozilla/5.0' "https://ci.android.com/builds/submitted/${emulatorBuild}/emulator-linux_aarch64/latest/sdk-repo-linux_aarch64-emulator-${emulatorBuild}.zip")"
      url="$(printf '%s' "$page" \
        | grep -oE 'https://storage.googleapis.com/android-build/[^"'"'"' <>]*sdk-repo-linux_aarch64-emulator-[0-9]+\.zip[^"'"'"' <>]*' \
        | head -1 | sed 's/\\u0026/\&/g')"
      echo "resolved signed URL: ''${url%%\?*}?…" >&2
      curl -sL -A 'Mozilla/5.0' "$url" -o "$out"
    '';
  };
  emulator = stdenv.mkDerivation {
    pname = "android-sdk-emulator-linux-aarch64";
    version = emulatorBuild;
    src = emulatorSrc;
    nativeBuildInputs = with pkgs; [
      unzip
      autoPatchelfHook
      makeWrapper
    ];
    buildInputs = with pkgs; [
      glibc
      libcxx
      libpulseaudio
      libtiff
      libuuid
      zlib
      libbsd
      ncurses5
      libdrm
      stdenv.cc.cc
      expat
      freetype
      nss
      nspr
      alsa-lib
      waylandpp.lib
      libgbm
      libx11
      libxext
      libxdamage
      libxfixes
      libxcb
      libxcomposite
      libxcursor
      libxi
      libxrender
      libxtst
      libice
      libsm
      libxkbfile
      libxshmfence
    ];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/libexec/android-sdk"
      cp -r emulator "$out/libexec/android-sdk/"
      runHook postInstall
    '';
    # Mirror emulator.nix's patchInstructions for the Linux emulator.
    postFixup = ''
      emu="$out/libexec/android-sdk/emulator"
      addAutoPatchelfSearchPath "$emu/lib64"
      addAutoPatchelfSearchPath "$emu/lib64/qt/lib"
      addAutoPatchelfSearchPath ${pkgs.libuuid.out}/lib
      for f in "$emu"/qt/plugins/imageformats/libqtiffAndroidEmu.so; do
        patchelf --replace-needed libtiff.so.5 libtiff.so "$f" || true
      done
      autoPatchelf "$out"
      wrapProgram "$emu/emulator" \
        --prefix LD_LIBRARY_PATH : ${
          lib.makeLibraryPath (
            with pkgs;
            [
              dbus
              systemd
              libGL
              libpulseaudio
              alsa-lib
            ]
          )
        }
    '';
  };

  # On aarch64-linux, merge the custom emulator into the emulator-less base SDK; elsewhere the
  # base already has the upstream emulator.
  sdk =
    if isAarch64Linux then
      pkgs.symlinkJoin
        {
          name = "androidsdk-with-aarch64-emulator";
          paths = [
            base.androidsdk
            emulator
          ];
        }
    else
      base.androidsdk;
in
{
  inherit sdk emulator;
}
