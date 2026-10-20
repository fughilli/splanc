# Keep the bridge image small (target: well under 1 GB compressed; the CI size
# step prints the closure's largest paths). The same trims td-deploy measured
# (its deploy/nix/lean-extra.nix) plus the sbc-deploy
# `lean` seam's docs/defaultPackages cut — this image has no Mesa/LLVM/X at all.
{ lib, modulesPath, ... }:
{
  # The RPi sd-image's rescue profile (vim, testdisk, ddrescue, a wide filesystem
  # set ...) — nothing a sealed appliance needs.
  disabledModules = [ (modulesPath + "/profiles/base.nix") ];

  documentation.enable = lib.mkForce false;
  documentation.man.enable = lib.mkForce false;
  documentation.nixos.enable = lib.mkForce false;
  documentation.doc.enable = lib.mkForce false;
  documentation.info.enable = lib.mkForce false;
  environment.defaultPackages = lib.mkForce [ ];

  # nixpkgs source (~186 MB) is only pulled by the on-device flake registry /
  # NIX_PATH; the appliance never evaluates Nix on the device.
  nix.registry = lib.mkForce { };
  nix.nixPath = lib.mkForce [ ];
  system.disableInstallerTools = true;

  # No cellular modem; no VPN plugins (sbc-base already empties those).
  networking.modemmanager.enable = false;

  # No X / desktop bits pulled in by defaults.
  fonts.fontconfig.enable = false;
  xdg.icons.enable = false;
  xdg.mime.enable = false;
  xdg.sounds.enable = false;
  services.udisks2.enable = false;
  programs.command-not-found.enable = false;

  nixpkgs.overlays = [
    (final: prev: {
      # NetworkManager's openconnect helper -> stoken -> gtk3 (45 MB): CLI-only stoken.
      stoken = prev.stoken.override { withGTK3 = false; };
      # NM's WWAN plugin pulls ModemManager + libqmi/libmbim (no modem here).
      networkmanager = prev.networkmanager.overrideAttrs (old: {
        mesonFlags = (old.mesonFlags or [ ]) ++ [ "-Dmodem_manager=false" ];
      });
    })
  ];
}
