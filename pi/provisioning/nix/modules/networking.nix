# Networking + zero-config discovery for the LED Mapper Pi.
#
# Design doc §3/§5: field use wants zero-config discovery. We expose the Pi as
# `ledmapper.local` over mDNS (avahi) so the phone and the deploy machine can
# find it by name. The original M4 scope also mentioned hostapd/dnsmasq AP mode;
# that is intentionally LEFT AS A SEAM here (see note) — the Nix-driven image
# defaults to joining an existing network + mDNS, which is simpler and the
# common bench case. AP mode can be layered in as an additional module later.
{ config, lib, pkgs, ... }:
{
  # mDNS / Bonjour: advertise ledmapper.local and resolve *.local.
  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
      domain = true;
      workstation = true;
    };
  };

  # Resolve .local names locally too.
  networking.firewall = {
    enable = true;
    # HTTP (web app + websocket), mDNS, and SSH (deploy).
    allowedTCPPorts = [ 22 80 ];
    allowedUDPPorts = [ 5353 ]; # mDNS
  };

  # Use NetworkManager for easy field Wi-Fi join. Credentials are NOT baked into
  # the image (no secrets in the store); configure on first boot or pre-seed a
  # gitignored wpa_supplicant/NM connection file out of band.
  networking.networkmanager.enable = lib.mkDefault true;

  # --------------------------------------------------------------------------
  # AP-MODE SEAM (design doc §5 "AP / provisioning").
  # To make the Pi its own access point in the field, add a module enabling
  # `services.hostapd` + `services.dnsmasq` here. Omitted from the default image
  # to keep first-boot behaviour predictable on a bench network. Documented in
  # ../README.md.
  # --------------------------------------------------------------------------
}
