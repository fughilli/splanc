# nix-darwin module: Grafana Alloy on the Mac HITL host, pushing its reservation
# daemon's metrics to Grafana Cloud — the darwin counterpart of alloy.nix (which
# is a NixOS systemd unit). Imported by nix/hitl-darwin.nix.
#
# Same contract as the Linux rigs:
#   - fleet-identical creds in /var/lib/hitl/grafana.env (GRAFANA_CLOUD_PROM_URL /
#     _USER / _KEY), seeded out-of-band by `bazel run //pi/hitl:seed_grafana -- mac-mini`;
#   - the `rig` label comes from the hostname (HITL_RIG), not the env file;
#   - dormant until the creds exist (launchd has no ConditionPathExists, so the
#     wrapper idles and exits; KeepAlive + ThrottleInterval retry every 5 min, and
#     seed_grafana kickstarts it once the file lands).
{ config, pkgs, lib, ... }:

let
  envFile = "/var/lib/hitl/grafana.env";
  rig = config.networking.hostName or "mac-mini";
  run = pkgs.writeShellScript "hitl-alloy-darwin" ''
    set -eu
    if [ ! -f ${envFile} ]; then
      echo "hitl-alloy: ${envFile} not seeded yet; idling" >&2
      exit 0
    fi
    set -a
    . ${envFile}
    set +a
    export HITL_RIG=${lib.escapeShellArg rig}
    mkdir -p /var/lib/hitl-alloy
    exec ${pkgs.grafana-alloy}/bin/alloy run ${./alloy-darwin.alloy} \
      --storage.path=/var/lib/hitl-alloy \
      --server.http.listen-addr=127.0.0.1:12345
  '';
in
{
  launchd.daemons.hitl-alloy = {
    serviceConfig = {
      ProgramArguments = [ "${run}" ];
      RunAtLoad = true;
      KeepAlive = true;
      ThrottleInterval = 300;
      UserName = "root"; # reads the root-only creds file, like the Linux unit's EnvironmentFile
      StandardOutPath = "/var/log/hitl-alloy.log";
      StandardErrorPath = "/var/log/hitl-alloy.err.log";
    };
  };
}
