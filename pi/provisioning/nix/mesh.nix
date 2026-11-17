# Mesh radio settings for the Pi player image (docs/design/mesh-pi-transport.md §2.1).
#
# Wi-Fi power save off: with it on, brcmfmac's receiver sleeps between AP beacons and
# missed 37 of 40 mesh broadcasts on the bench (power save off: 96-99 %). The mesh's
# frames are not buffered by the AP, so a mesh Pi must listen all the time. Costs
# ~0.1-0.3 W. The bridge image sets the same (pi/bridge/image/nix/bridge.nix).
{ config, lib, ... }:
{
  networking.networkmanager.wifi.powersave = lib.mkIf config.networking.networkmanager.enable false;
}
