# Apply the per-card settings the Splanc Bridge Flasher wrote to the FAT boot
# partition: hostname, WiFi profiles, WiFi country, bridge/display settings and
# optional SSH keys (splanc_image/bootconfig.py documents the files).
#
# Same mechanism as td-deploy's deploy/nix/flash-config.nix: a oneshot on every
# boot, before NetworkManager and avahi, so they start with the right name and
# networks. Missing files are a no-op and nothing here can fail the boot.
{ config, lib, pkgs, ... }:
let
  bp = pkgs.callPackage ./packages.nix { };
in
{
  systemd.services.splanc-flash-config = {
    description = "Apply flash-time settings from /boot/firmware";
    wantedBy = [ "multi-user.target" ];
    unitConfig.RequiresMountsFor = [ "/boot/firmware" ];
    before = [
      "NetworkManager.service"
      "avahi-daemon.service"
      "splanc-bridge.service"
      "splanc-display.service"
      "sshd.service"
    ];
    after = [ "local-fs.target" ];
    path = [ pkgs.inetutils pkgs.iw ];
    environment = {
      PYTHONPATH = "${bp.splancPy}";
      PYTHONDONTWRITEBYTECODE = "1";
    };
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${bp.pyEnv}/bin/python3 -m splanc_image.bootconfig --boot /boot/firmware";
    };
  };
}
