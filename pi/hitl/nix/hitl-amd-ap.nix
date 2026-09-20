# A controlled 2.4 GHz hostapd AP on amd-rig's onboard WiFi (wlp2s0) for the phone
# HITL bench. Two jobs:
#
#   1. Serve the phone connect/config journeys. The reserved C6 + the phone both join
#      this AP, so the phone reaches the C6 at the IP in its self-signed cert — the
#      firmware's DESIGNED trust flow (visit https://<c6-ip>/ → accept the cert once →
#      the same-host wss://<c6-ip>/ws works). A commercial/home AP can't do this today:
#      the heapless netstack can't hold a commercial AP's association (it falls off on a
#      group-key rekey), so the C6 goes unreachable. A controlled AP the netstack is
#      known-good on unblocks the journey now.
#
#   2. Reproduce the commercial-AP reliability bug ON THE BENCH so the netstack fix can
#      be regression-tested. Set SBC_AP_REKEY=<seconds> to make hostapd rekey the group
#      key on that interval (what a commercial AP does periodically); a netstack that
#      ignores the rekey EAPOL exchange gets deauthed, reproducing the CoolerKids drop.
#      DEFAULT IS OFF (0) so the connect journey is reliable; opt in only to exercise
#      the rekey path. Broadcast DHCP OFFER is ON by default (netstack already handles
#      the group-RX + GTK-decrypt path — matches the Pi rigs' apBroadcastDhcp); opt out
#      with SBC_AP_LENIENT=1.
#
# wl* is left NetworkManager-unmanaged by hitl-sdr.nix, so this module owns wlp2s0
# outright (raw hostapd + dnsmasq + NAT through the wired uplink eno1).
{ config, pkgs, lib, ... }:
let
  iface = "wlp2s0";
  uplink = "eno1";
  apAddr = "192.168.60.1";
  apCidr = "${apAddr}/24";
  ssid = "amd-rig-ap";
  # World-readable, same posture as the Pi rigs' apPsk (the harness/agent knows it;
  # it's a lab provisioning AP, not a secret). ≥8 chars for WPA2.
  psk = "amd-rig-provision";
  channel = 6; # fixed 2.4 GHz channel; the C6 is 2.4-only
  # Commercial-AP mimic knobs (env-flag pattern, like hitl-app.nix's apBroadcastDhcp):
  rekeySecs = let v = builtins.getEnv "SBC_AP_REKEY"; in if v == "" then 0 else lib.toInt v;
  broadcastDhcp = builtins.getEnv "SBC_AP_LENIENT" != "1";

  hostapdConf = pkgs.writeText "amd-ap-hostapd.conf" (''
    interface=${iface}
    driver=nl80211
    ssid=${ssid}
    hw_mode=g
    channel=${toString channel}
    wmm_enabled=1
    auth_algs=1
    wpa=2
    wpa_passphrase=${psk}
    wpa_key_mgmt=WPA-PSK
    rsn_pairwise=CCMP
    wpa_pairwise=CCMP
  '' + lib.optionalString (rekeySecs > 0) ''
    wpa_group_rekey=${toString rekeySecs}
  '');

  dnsmasqConf = pkgs.writeText "amd-ap-dnsmasq.conf" (''
    interface=${iface}
    bind-interfaces
    except-interface=lo
    dhcp-range=192.168.60.50,192.168.60.150,255.255.255.0,1h
    dhcp-option=option:router,${apAddr}
    dhcp-option=option:dns-server,${apAddr}
    dhcp-authoritative
    # DNS: forward to the host's resolvers so AP clients (the phone) have internet and
    # Android doesn't drop the "no internet" network.
    server=1.1.1.1
    server=8.8.8.8
  '' + lib.optionalString broadcastDhcp ''
    dhcp-broadcast
  '');
in
{
  environment.systemPackages = [ pkgs.hostapd pkgs.dnsmasq pkgs.iw ];

  # AP subnet clients (the C6 + phone) reach each other + the host; internet via NAT.
  boot.kernel.sysctl."net.ipv4.ip_forward" = 1;
  networking.nat = {
    enable = true;
    externalInterface = uplink;
    internalInterfaces = [ iface ];
  };
  networking.firewall.trustedInterfaces = [ iface ];

  # hostapd on the NM-unmanaged radio.
  systemd.services.amd-ap = {
    description = "amd-rig HITL provisioning AP (hostapd on ${iface})";
    after = [ "network-pre.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStartPre = "${pkgs.util-linux}/bin/rfkill unblock wifi";
      ExecStart = "${pkgs.hostapd}/bin/hostapd ${hostapdConf}";
      Restart = "always";
      RestartSec = 3;
    };
  };

  # Assign the AP address AFTER hostapd owns the interface (hostapd flips it to AP mode
  # on start, which would flush an IP added earlier), then never flush it.
  systemd.services.amd-ap-ip = {
    description = "amd-rig AP address on ${iface}";
    after = [ "amd-ap.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStartPre = "${pkgs.coreutils}/bin/sleep 3";
      ExecStart = "${pkgs.iproute2}/bin/ip addr replace ${apCidr} dev ${iface}";
    };
  };

  # DHCP + DNS for AP clients, after the address exists.
  systemd.services.amd-ap-dnsmasq = {
    description = "amd-rig AP DHCP/DNS (dnsmasq on ${iface})";
    after = [ "amd-ap-ip.service" ];
    requires = [ "amd-ap-ip.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.dnsmasq}/bin/dnsmasq -k -C ${dnsmasqConf}";
      Restart = "always";
      RestartSec = 3;
    };
  };
}
