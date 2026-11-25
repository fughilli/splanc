# The Pi's own radio as a plain-Linux mesh radio (docs/design/mesh-pi-transport.md §2.1):
# brcmfmac with the action-frame series (brcmfmac-actframe/, sent upstream to
# wireless-next), so NL80211_CMD_FRAME sends Splanc's Public Action frames with a real ACK
# status and received ones carry NL80211_ATTR_RX_SIGNAL_DBM. Without it the mesh needs the
# firmware-passthrough send (vendor DCMD `actframe`) and the tracefs kprobe tap for RSSI.
#
# Only the driver is rebuilt (brcmfmac-actframe/package.nix); its modules land in
# lib/modules/<ver>/updates, which depmod prefers over the kernel's copies. The source
# version of the patched brcmfmac goes to /etc/splanc/brcmfmac-actframe.srcversion:
# pi/mesh_radio (`--via auto`, the default) compares it with the loaded module's
# /sys/module/brcmfmac/srcversion and uses plain nl80211 only when they match, so a stock
# kernel (or a module that failed to load) falls back to passthrough + kprobe tap.
{ config, lib, pkgs, ... }:
let
  cfg = config.splanc.brcmfmacActframe;
  kernel = config.boot.kernelPackages.kernel;
  pkg = pkgs.callPackage ./brcmfmac-actframe/package.nix { inherit kernel; };
in
{
  options.splanc.brcmfmacActframe = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Carry the brcmfmac action-frame patches (plain nl80211 mesh radio).";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = pkg;
      readOnly = true;
      description = "The patched brcmfmac modules for the image kernel.";
    };
  };

  config = lib.mkIf cfg.enable {
    boot.extraModulePackages = [ cfg.package ];
    environment.etc."splanc/brcmfmac-actframe.srcversion".source =
      "${cfg.package}/share/splanc/brcmfmac-actframe.srcversion";
  };
}
