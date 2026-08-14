# NixOS module that runs Grafana Alloy on a HITL rig to ship metrics to Grafana
# Cloud (FUG-117). Import it from the rig's system config alongside hitl-app.nix:
#
#   imports = [ ./hitl-app.nix ./observability/alloy.nix ];
#
# It's intentionally a separate, opt-in module rather than baked into
# hitl-app.nix: a rig only reports once its Grafana Cloud credentials exist. The
# service is gated on an EnvironmentFile (ConditionPathExists) holding:
#
#   GRAFANA_CLOUD_PROM_URL=https://prometheus-prod-NN-REGION.grafana.net/api/prom/push
#   GRAFANA_CLOUD_PROM_USER=<numeric metrics instance id>
#   GRAFANA_CLOUD_PROM_KEY=<access-policy token, metrics:write>
#   HITL_RIG=<this rig's name; match hitl-managerd --rig>
#
# Provision that file out-of-band (like the Tailscale authkey / WiFi creds — see
# scripts/seed-*.sh) at the path below; until it exists Alloy simply doesn't
# start, so importing this module never breaks a rig that isn't wired to Grafana
# yet. The alloy.alloy config next to this file is the scrape/remote_write spec.
{ config, pkgs, lib, ... }:

let
  # The Alloy pipeline config (scrape localhost:8087/metrics + host metrics,
  # remote_write to Grafana Cloud). Copied into the store so it's part of the
  # system closure and updates atomically with a rebuild.
  alloyConfig = ./alloy.alloy;
  envFile = "/var/lib/hitl/grafana.env";
in
{
  systemd.services.hitl-alloy = {
    description = "Grafana Alloy — ship HITL rig metrics to Grafana Cloud";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "tailscaled.service" "hitl-manager.service" ];
    wants = [ "network-online.target" ];
    # Don't start until the operator has dropped in the Grafana Cloud creds.
    unitConfig.ConditionPathExists = envFile;
    serviceConfig = {
      # `alloy` is the binary name inside the grafana-alloy package.
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.grafana-alloy}/bin/alloy run"
        "${alloyConfig}"
        "--storage.path=/var/lib/hitl-alloy"
        # No inbound scrape UI needed; bind the built-in server to loopback only.
        "--server.http.listen-addr=127.0.0.1:12345"
      ];
      EnvironmentFile = envFile;
      StateDirectory = "hitl-alloy";
      DynamicUser = true;
      Restart = "on-failure";
      RestartSec = 5;
    };
  };
}
