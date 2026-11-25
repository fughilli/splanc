# The U-Boot -> kernel loader migration (nix/system-update-rpi.nix) on a fake
# FAT partition, with a real board system:
#
#   nix build ./pi/bridge/image#checks.aarch64-linux.migrate-pi3 -L
#
#   1. installed by the OLD (U-Boot) system's updater (the running system isn't
#      the new one): config.txt still boots U-Boot, the generational layout is
#      next to it, tryboot.txt boots it, and the reboot becomes "0 tryboot";
#   2. the trial passed, the NEW system commits (it is now the running one): the
#      kernel loader's own install writes config.txt; no tryboot reboot.
{ pkgs, system }:
let
  sys = system.config.system.build;
  top = sys.toplevel;
  install = sys.splancInstallBootLoader;
in
pkgs.runCommand "splanc-migrate-uboot-${system.config.splancBridge.board}" { } ''
  set -eu
  fw=$TMPDIR/fw run=$TMPDIR/run
  mkdir -p $fw $run
  printf 'kernel=u-boot-rpi-arm64.bin\narm_64bit=1\n' >$fw/config.txt
  touch $fw/u-boot-rpi-arm64.bin
  export SPLANC_FIRMWARE_DIR=$fw SPLANC_SYSTEMD_RUN_DIR=$run SPLANC_BOOTED_SYSTEM=/nonexistent

  echo "== 1. the old system installs the new one"
  ${install} ${top}
  grep -qx 'kernel=u-boot-rpi-arm64.bin' $fw/config.txt
  test -e $fw/u-boot-rpi-arm64.bin
  grep -qx 'kernel=kernel.img' $fw/tryboot.txt
  grep -qx 'os_prefix=nixos/default/' $fw/tryboot.txt
  grep -q 'initramfs initrd followkernel' $fw/tryboot.txt
  grep -q "init=${top}/init" $fw/nixos/default/cmdline.txt
  test -s $fw/nixos/default/kernel.img
  test -s $fw/nixos/default/initrd
  ls $fw/nixos/default/ | grep -q '^bcm27.*\.dtb$'
  test -d $fw/nixos/default/overlays
  test "$(cat $run/reboot-param)" = "0 tryboot"
  test ! -e $fw/.splanc-kernel-loader.tmp
  ls -la $fw $fw/nixos/default | head -40
  du -sh $fw

  echo "== 2. the new system commits"
  rm $run/reboot-param
  SPLANC_BOOTED_SYSTEM=${top} ${install} ${top}
  grep -qx 'kernel=kernel.img' $fw/config.txt
  grep -qx 'os_prefix=nixos/default/' $fw/config.txt
  test ! -e $run/reboot-param
  grep -q "init=${top}/init" $fw/nixos/default/cmdline.txt
  mkdir -p $out
  cp $fw/config.txt $fw/tryboot.txt $out/
  du -sh $fw >$out/fat-usage.txt
''
