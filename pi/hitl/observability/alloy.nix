# NixOS module that runs Grafana Alloy on a HITL rig to ship metrics to Grafana
# Cloud (FUG-117). It's a FUNCTION of an optional `extraScrapeJobs` arg, so import
# it applied — from the rig's system config alongside hitl-app.nix:
#
#   imports = [ ./hitl-app.nix (import ./observability/alloy.nix { }) ];
#
# (A host with a second daemon passes extra scrape targets — see below / flake.nix.)
#
# It's intentionally a separate, opt-in module rather than baked into
# hitl-app.nix: a rig only reports once its Grafana Cloud credentials exist. The
# service is gated on an EnvironmentFile (ConditionPathExists) holding only the
# shared Grafana Cloud creds (identical across the fleet):
#
#   GRAFANA_CLOUD_PROM_URL=https://prometheus-prod-NN-REGION.grafana.net/api/prom/push
#   GRAFANA_CLOUD_PROM_USER=<numeric metrics instance id>
#   GRAFANA_CLOUD_PROM_KEY=<access-policy token, metrics:write>
#
# HITL_RIG (the per-series `rig` label) is NOT in that file — it's injected below
# from config.networking.hostName so it always matches hitl-managerd --rig, the
# AP SSID, and the tailnet name, with no per-rig env file to keep in sync.
#
# Provision that file out-of-band (like the Tailscale authkey / WiFi creds — see
# scripts/seed-*.sh) at the path below; until it exists Alloy simply doesn't
# start, so importing this module never breaks a rig that isn't wired to Grafana
# yet. The alloy.alloy config next to this file is the scrape/remote_write spec.
#
# `extraScrapeJobs` lets a host that runs MORE than the one reservation daemon add
# scrape targets to the shared pipeline. The Pi rigs run a single daemon on :8087
# (the base config), so they import this with the default (empty) list and get the
# alloy.alloy file verbatim. amd-rig runs a SECOND daemon — the phone bench on
# :8088 (hitl-phone-daemon.nix) — so flake.nix passes it a `hitl-managerd-phone`
# job here; without it, amd-rig's phone-bench DUTs (its two C6s + the Android
# phone) would push nothing and be invisible on Grafana. Each entry is
# { name (Alloy block label, a valid identifier); job (the `job` label);
#   address ("host:port") } — see flake.nix for the amd-rig value.
{ extraScrapeJobs ? [ ] }:
{ config, pkgs, lib, ... }:

let
  # The base Alloy pipeline (scrape localhost:8087/metrics + host metrics,
  # remote_write to Grafana Cloud), plus any extra per-host scrape blocks. Copied
  # into the store as a single file so it's part of the system closure and updates
  # atomically with a rebuild. With no extraScrapeJobs (the Pi rigs) the generated
  # file is byte-identical to alloy.alloy.
  mkScrape = j: ''

    // Extra reservation daemon on this host (injected by alloy.nix's
    // extraScrapeJobs) — scraped exactly like the primary :8087 daemon and
    // tagged with its own `job` so the two daemons' series stay distinct.
    prometheus.scrape ${builtins.toJSON j.name} {
      targets = [
        { "__address__" = ${builtins.toJSON j.address}, "job" = ${builtins.toJSON j.job} },
      ]
      metrics_path    = "/metrics"
      scrape_interval = "15s"
      forward_to      = [prometheus.remote_write.grafana_cloud.receiver]
    }
  '';
  alloyConfig = pkgs.writeText "alloy.alloy"
    (builtins.readFile ./alloy.alloy + lib.concatMapStrings mkScrape extraScrapeJobs);
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
      # Per-rig identity for the `rig` label, from the single source of truth
      # (the hostname) — matches hitl-managerd --rig / apSsid / the tailnet name.
      # Set here rather than in grafana.env so the env file stays fleet-identical.
      Environment = [ "HITL_RIG=${config.networking.hostName}" ];
      EnvironmentFile = envFile;
      StateDirectory = "hitl-alloy";
      DynamicUser = true;
      Restart = "on-failure";
      RestartSec = 5;
    };
  };
}
