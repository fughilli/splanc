# The bridge as a Splanc mesh member (issue #697): `pimesh serve` on the Pi's own Wi-Fi
# radio (pi/mesh_radio/src/bridge.rs; docs/design/mesh-pi-transport.md).
#
#   splanc-mesh.service   the full mesh stack the C6 runs, over wlan0. `--via auto` picks
#                         plain nl80211 when the loaded brcmfmac is the image's patched one
#                         (/etc/splanc/brcmfmac-actframe.srcversion, written by
#                         pi/provisioning/nix/brcmfmac-actframe.nix since pi-bridge-v1.3.0)
#                         and the firmware passthrough otherwise. Its device key and mesh
#                         state live in /var/lib/splanc-mesh; the agent (splanc-bridge,
#                         user splanc) drives it over /run/splanc-mesh/mesh.sock.
#
# The binary is the one in the agent bundle baked into this image (pi-bridge/mesh/pimesh,
# a static aarch64 musl build of //pi/mesh_radio:pimesh_musl): a read-only store path, so
# it changes only with a system update, never with a bundle an update dropped in /var.
# A bundle pin that predates it has none: the unit's condition then skips it.
#
# Not root: a user of its own with CAP_NET_ADMIN only (nl80211 frame TX/registration and
# brcmfmac's vendor command). The kprobe tap of the passthrough path needs root, so on a
# stock driver it runs without RSSI or ACK status; the image's patched driver gives both.
#
# Channel: AP-anchored like every C6 (mesh.md §4.2). The bridge stays associated to its
# Wi-Fi and meshes on that channel; Wi-Fi power save is already off (nix/bridge.nix).
{ config, lib, pkgs, ... }:
let
  cfg = config.splancBridge.mesh;
  bp = pkgs.callPackage ./packages.nix { };
  pimesh = "${bp.agentBundle}/pi-bridge/mesh/pimesh";
  stateDir = "/var/lib/splanc-mesh";
  socket = "/run/splanc-mesh/mesh.sock";

  meshRun = pkgs.writeShellScript "splanc-mesh-run" ''
    set -u
    # NetworkManager brings wlan0 up after us on a cold boot.
    for _ in $(${pkgs.coreutils}/bin/seq 1 60); do
      [ -e /sys/class/net/${cfg.interface} ] && break
      ${pkgs.coreutils}/bin/sleep 2
    done
    exec ${pimesh} serve ${cfg.interface} --via auto --state-dir ${stateDir} --socket ${socket}
  '';
in
{
  options.splancBridge.mesh = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the bridge's mesh member (splanc-mesh.service).";
    };
    interface = lib.mkOption {
      type = lib.types.str;
      default = "wlan0";
      description = "The Wi-Fi interface the bridge meshes on (its own, associated).";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.splanc-mesh = {
      isSystemUser = true;
      group = "splanc";
    };

    systemd.services.splanc-mesh = {
      description = "Splanc mesh member (the bridge's own Wi-Fi radio)";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network.target" ];
      after = [ "network.target" "NetworkManager.service" ];
      unitConfig = {
        ConditionPathExists = pimesh;
        StartLimitIntervalSec = 0;
      };
      serviceConfig = {
        Type = "simple";
        User = "splanc-mesh";
        Group = "splanc";
        ExecStart = meshRun;
        AmbientCapabilities = [ "CAP_NET_ADMIN" ];
        CapabilityBoundingSet = [ "CAP_NET_ADMIN" ];
        StateDirectory = "splanc-mesh";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "splanc-mesh";
        RuntimeDirectoryMode = "0750";
        UMask = "0007";
        Restart = "always";
        RestartSec = 5;
        MemoryMax = "96M";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_NETLINK" ];
      };
    };

    # The agent finds the member here (agent/src/bridge/mesh.ts).
    systemd.services.splanc-bridge.environment.SPLANC_MESH_SOCKET = socket;
    systemd.services.splanc-bridge.serviceConfig.ReadWritePaths = [ "-/run/splanc-mesh" ];
  };
}
