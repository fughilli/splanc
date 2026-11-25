# brcmfmac (+ brcmutil and the vendor modules) rebuilt for the image kernel with the
# action-frame series (0001-0004, sent upstream to wireless-next) and the 6.12 channel
# backport (0005). Only the driver is rebuilt, from the kernel's own source, config and
# patches; the modules go to lib/modules/<ver>/updates, which depmod prefers over the
# kernel's own copies. The kernel's `dev` output is not cached anywhere we pull from (the
# kernel `out` is, on fugstudio.cachix.org), so the build reads the MODVERSIONS CRCs of
# everything the driver imports from the stock modules and fails unless the rebuilt
# modules' exports carry the stock CRCs (ABI-identical build) and nothing is undefined.
{ lib
, kernel
, python3
, xz
, kmod
, bc
, bison
, flex
, openssl
, perl
, elfutils
, zlib
,
}:

let
  ver = kernel.modDirVersion;
  brcm = "drivers/net/wireless/broadcom/brcm80211";
  stock = "${kernel}/lib/modules/${ver}/kernel/${brcm}";
  arch = kernel.stdenv.hostPlatform.linuxArch;
  cross = kernel.stdenv.cc.targetPrefix;
in
kernel.stdenv.mkDerivation {
  pname = "brcmfmac-actframe";
  version = ver;
  inherit (kernel) src;

  # The kernel's own patches first (an identical tree), then ours.
  # (Config-only kernelPatches, patch = null, change the .config, not the tree.)
  patches = map (p: p.patch) (lib.filter (p: p.patch != null) kernel.kernelPatches) ++ [
    ./0001-wifi-brcmfmac-report-the-signal-of-received-action-f.patch
    ./0002-wifi-brcmfmac-complete-action-frames-sent-without-a-.patch
    ./0003-wifi-brcmfmac-do-not-wait-for-an-ACK-of-group-addres.patch
    ./0004-wifi-brcmfmac-send-action-frames-that-are-not-P2P-GA.patch
    ./0005-wifi-brcmfmac-mgmt_tx-channel-number-6.12-backport.patch
    # Not mesh: silences the FORTIFY false positive every boot logs (bridge too).
    ./0007-wifi-brcmfmac-make-eventmsgs_ext-mask-a-flexible-array.patch
  ];

  nativeBuildInputs = (kernel.moduleBuildDependencies or [ ]) ++ [
    python3
    xz
    kmod
    bc
    bison
    flex
    openssl
    perl
    elfutils
  ];
  # modules_prepare builds resolve_btfids (CONFIG_DEBUG_INFO_BTF), which links libelf + zlib.
  buildInputs = [
    elfutils
    zlib
  ];

  makeFlags = [
    "ARCH=${arch}"
    "CROSS_COMPILE=${cross}"
    "O=../kbuild"
  ];
  enableParallelBuilding = true;

  postPatch = ''
    patchShebangs scripts
  '';

  configurePhase = ''
    runHook preConfigure
    mkdir ../kbuild
    cp ${kernel.configfile} ../kbuild/.config
    make $makeFlags olddefconfig
    # The kernel's own post-configure fixups (nixos-raspberrypi clears CONFIG_LOCALVERSION
    # there, so kernel.release is the modDirVersion).
    buildRoot=$(realpath ../kbuild)
    ${kernel.postConfigure or ""}
    grep -q '^CONFIG_BRCMFMAC=m' ../kbuild/.config || { echo "brcmfmac is not a module in this kernel"; exit 1; }
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make $makeFlags -j$NIX_BUILD_CORES modules_prepare
    release=$(cat ../kbuild/include/config/kernel.release)
    [ "$release" = "${ver}" ] || { echo "kernel.release $release != ${ver}"; exit 1; }

    mkdir ../stock
    for ko in $(find ${stock} -name '*.ko.xz' -not -path '*/brcmsmac/*'); do
      xz -dc "$ko" > ../stock/$(basename "$ko" .xz)
    done
    python3 ${./symvers.py} imports ../stock/*.ko > ../imports.symvers

    cp -r ${brcm} ../ext
    make $makeFlags -j$NIX_BUILD_CORES M=$(realpath ../ext) \
      KBUILD_EXTRA_SYMBOLS=$(realpath ../imports.symvers) CONFIG_BRCMSMAC= modules 2>&1 | tee ../build.log
    if grep -E 'undefined!|has no CRC' ../build.log; then
      echo "symbols without a stock CRC: the patches import something the stock driver does not"
      exit 1
    fi
    python3 ${./symvers.py} check ../ext/Module.symvers ../stock/*.ko
    for ko in $(find ../ext -name '*.ko'); do
      vm=$(modinfo -F vermagic "$ko")
      [ "''${vm%% *}" = "${ver}" ] || { echo "$ko vermagic $vm"; exit 1; }
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    dst=$out/lib/modules/${ver}/updates/brcm80211
    (cd ../ext && find . -name '*.ko' | while read -r ko; do
      install -Dm444 "$ko" "$dst/$ko"
      xz --check=crc32 --lzma2=dict=1MiB "$dst/$ko"
    done)
    # pi/mesh_radio matches this against /sys/module/brcmfmac/srcversion (patched driver
    # loaded -> plain nl80211).
    mkdir -p $out/share/splanc
    modinfo -F srcversion ../ext/brcmfmac/brcmfmac.ko > $out/share/splanc/brcmfmac-actframe.srcversion
    [ -s $out/share/splanc/brcmfmac-actframe.srcversion ]
    runHook postInstall
  '';

  meta = {
    description = "brcmfmac with action-frame TX/RSSI fixes for the Splanc mesh";
    license = lib.licenses.isc;
    platforms = lib.platforms.linux;
  };
}
