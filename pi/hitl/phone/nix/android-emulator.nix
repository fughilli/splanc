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

  # The arm64-linux emulator's only public source was Google's CI (aosp-emu-master-dev), since
  # neither nixpkgs' manifest nor dl.google.com's SDK channel ships a linux-aarch64 emulator.
  # (repository2-*.xml carries emulator-linux_x64 + emulator-darwin_aarch64 only — verified.)
  #
  # ⚠ DISCONTINUED UPSTREAM (checked 2026-09): aosp-emu-master-dev is FROZEN — its last green
  # build is 13278466 (2025-03-28) and even that build's linux_aarch64 zip has been
  # garbage-collected (getdownloadurl → "attempt … not found"; a maintainer confirmed the grid
  # download 404s). No successor branch publishes a linux_aarch64 target, and the current
  # released emulator (build ~16.3M) has no linux_aarch64 target at all. So there is nothing
  # live to pin: this leg cannot be completed from Google's CI right now.
  #
  # → USE A DIFFERENT STATION. macOS (Apple Silicon or Intel) and linux-x86_64 get the emulator
  #   from nixpkgs upstream (the `base` SDK above, includeEmulator on those hosts) — NO pin
  #   needed. Only a native arm64-LINUX station (Asahi / arm cloud) hits this gap; the sole
  #   remaining route there is building the emulator from source (repo init … emu-master-dev),
  #   which is a multi-hour build and out of scope here.
  #
  # If Google ever republishes a linux_aarch64 emulator: set `emulatorBuild` to that build id
  # and run `bazel build //pi/hitl/phone:android_emulator` once — nix prints the real `got:`
  # hash — then paste it into `outputHash`. The fetch machinery below (the getdownloadurl
  # redirect API) is verified reachable; it just has nothing to fetch today. Left UNSET (0) so
  # it fails loudly rather than pretending a purged build is real.
  emulatorBuild = "0"; # UNSET — arm64-linux emulator is discontinued upstream (see above).
  # There is no stable direct URL: ci.android.com serves the artifact only via a TEMPORARY
  # signed storage.googleapis.com URL (Expires=…&Signature=…), and its build API's
  # `…/artifacts/<zip>/url?redirect=true` 302-redirects to that signed URL. Anonymous access is
  # allowed for public builds (verified: the endpoint returns semantic 404s, not auth errors).
  # A fixed-output derivation is the right tool — reproducible by its OUTPUT hash (the zip's
  # content sha256) while its builder gets network to resolve the fresh signed URL each build.
  emulatorApi = "https://androidbuildinternal.googleapis.com/android/internal/build/v3";
  emulatorArtifact = "sdk-repo-linux_aarch64-emulator-${emulatorBuild}.zip";
  emulatorSrc = stdenv.mkDerivation {
    name = emulatorArtifact;
    nativeBuildInputs = with pkgs; [
      cacert
      curl
      gnugrep
    ];
    outputHashMode = "flat";
    outputHash = lib.fakeHash; # replace with the `got:` hash after pinning a current build.
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    buildCommand = ''
      url="${emulatorApi}/builds/${emulatorBuild}/emulator-linux_aarch64/attempts/latest/artifacts/${emulatorArtifact}/url?redirect=true"
      # -f: the API 404s (JSON) for a purged/missing build → fail the build, don't hash an error.
      # -L: follow the 302 to the signed storage.googleapis.com URL.
      curl -fsSL -A 'Mozilla/5.0' "$url" -o "$out"
      # Belt-and-suspenders: a real artifact starts with the ZIP magic "PK".
      if ! head -c2 "$out" | grep -q 'PK'; then
        echo "ci.android.com returned no zip for build ${emulatorBuild} — purged, or no linux_aarch64 target on this build?" >&2
        head -c 400 "$out" >&2
        echo >&2
        exit 1
      fi
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
