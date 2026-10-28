# Full-system OTA updates for the bridge (splanc_image/sysupdate.py has the
# mechanism; pi/bridge/README.md "System updates" the overview).
#
#   splanc-system-update.timer      every 15 min (first: 10 min after boot). The
#                                   service checks the channel every ~6 h, stages
#                                   (download + signature check + import) a new
#                                   system, and applies it (profile + boot entry
#                                   + reboot) once no app is connected.
#   splanc-system-update-confirm    every boot: a pending update's health check
#                                   -> commit, or roll back to the previous
#                                   generation and reboot.
#   splanc-system-update            CLI: status | check | apply
#
# Separate from the agent-bundle fast path (splanc-agent-update in bridge.nix),
# which still swaps the Node bundle in /var/lib/splanc-agent without a reboot.
#
# Trust: only store paths signed by a key in ../ota-public-keys.txt are
# accepted (CI's ota-sign job signs releases with the matching secret,
# BRIDGE_NIX_SIGNING_KEY in the `Bridge release` environment).
# With no key in that file the updater is installed but reports "disabled".
{ config, lib, pkgs, ... }:
let
  cfg = config.splancBridge.systemUpdate;
  bp = pkgs.callPackage ./packages.nix { };
  nix = config.nix.package;
  py = [ "${bp.pyEnv}/bin/python3" "-m" "splanc_image.sysupdate" ];

  settings = {
    channel_url = cfg.channelUrl;
    board = config.splancBridge.board;
    public_keys = cfg.publicKeys;
    boot_mode = cfg.bootMode;
    health_units = cfg.healthUnits;
    health_timeout = cfg.healthTimeout;
    health_stable = cfg.healthStable;
    allow_http = cfg.allowHttp;
  } // cfg.extraSettings;

  env = {
    PYTHONPATH = "${bp.splancPy}";
    PYTHONDONTWRITEBYTECODE = "1";
  };
  path = [ nix config.systemd.package pkgs.coreutils ];

  cli = pkgs.writeShellScriptBin "splanc-system-update" ''
    export PYTHONPATH=${bp.splancPy} PYTHONDONTWRITEBYTECODE=1
    export PATH=${lib.makeBinPath path}:$PATH
    case "''${1:-status}" in
      status) exec ${lib.escapeShellArgs py} status ;;
      check | apply)
        [ "$(id -u)" = 0 ] || { echo "splanc-system-update $1: run as root" >&2; exit 1; }
        exec ${lib.escapeShellArgs py} "$@" ;;
      logs) shift; exec journalctl -u splanc-system-update -u splanc-system-update-confirm --no-pager -n 200 "$@" ;;
      *) echo "usage: splanc-system-update [status|check|apply|logs]" >&2; exit 2 ;;
    esac
  '';
in
{
  options.splancBridge.systemUpdate = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Full-system OTA updates (signed Nix closures from the release channel).";
    };
    publicKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lib.filter (l: l != "" && !(lib.hasPrefix "#" l))
        (map lib.trim (lib.splitString "\n" (builtins.readFile ../ota-public-keys.txt)));
      description = "Nix public keys (name:base64) a system release must be signed with.";
    };
    channelUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://github.com/fughilli/splanc/releases/download/pi-bridge-ota/bridge-system-${config.splancBridge.board}.json";
      description = "Channel pointer (CI's pi-bridge-ota release) naming this board's current system.";
    };
    bootMode = lib.mkOption {
      type = lib.types.enum [ "reboot" "tryboot" ];
      default = "reboot";
      description = ''
        reboot: the new generation becomes the boot default, then reboot (health
        check -> rollback needs the new system to boot). tryboot: Raspberry Pi 5
        one-shot trial boot via tryboot.txt (nix/system-update-rpi.nix).
      '';
    };
    healthUnits = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Units that must be active (and stay up for healthStable seconds) on a
        freshly updated system, or it is rolled back. Modules that add a service
        the bridge needs append it here.
      '';
    };
    healthTimeout = lib.mkOption {
      type = lib.types.int;
      default = 300;
      description = "Seconds after boot the new system has to pass the health check.";
    };
    healthStable = lib.mkOption {
      type = lib.types.int;
      default = 30;
      description = "Seconds each health unit must have been up without a restart.";
    };
    allowHttp = lib.mkOption {
      type = lib.types.bool;
      default = false;
      internal = true; # the VM test serves the channel over local http
    };
    extraSettings = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      internal = true; # tests: gc, check intervals ...
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = lib.all (k: builtins.match "[A-Za-z0-9._-]+:[A-Za-z0-9+/]{43}=" k != null) cfg.publicKeys;
      message = "splancBridge.systemUpdate.publicKeys: not a Nix public key (name:base64)";
    }];

    splancBridge.systemUpdate.healthUnits = [
      "splanc-bridge.service"
      "splanc-display.service"
      "NetworkManager.service"
    ];

    environment.etc."splanc-bridge/system-update.json".text = builtins.toJSON settings;
    environment.systemPackages = [ cli ];

    # A kernel panic or a stage-1 failure reboots instead of hanging (with the
    # Pi 5's tryboot, a failed trial boot then comes back as the old system),
    # and the hardware watchdog resets a hung userspace. 15 s: the bcm2835
    # watchdog's maximum.
    boot.kernelParams = [ "panic=10" "boot.panic_on_fail" ];
    systemd.watchdog.runtimeTime = "15s";

    systemd.tmpfiles.rules = [ "d /run/splanc-system-update 0755 root root -" ];

    systemd.services.splanc-system-update = {
      description = "Splanc bridge system update (check, stage, apply when idle)";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" "time-sync.target" "splanc-flash-config.service" "splanc-system-update-confirm.service" ];
      inherit path;
      environment = env;
      # Never a stop job of its own: the apply step ends in a reboot.
      restartIfChanged = false;
      unitConfig.ConditionPathExists = "/etc/splanc-bridge/system-update.json";
      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = "-/run/splanc-flash/bridge.env";
        StateDirectory = "splanc-system-update";
        StateDirectoryMode = "0700";
        ExecStart = lib.escapeShellArgs (py ++ [ "run" "--auto" ]);
        # Root (nix-env, switch-to-configuration, /boot/firmware), but not more
        # than that needs.
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        Nice = 10;
        IOSchedulingClass = "idle";
      };
    };

    systemd.timers.splanc-system-update = {
      description = "Check for a Splanc bridge system update";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "10min";
        OnUnitActiveSec = "15min";
      };
    };

    systemd.services.splanc-system-update-confirm = {
      description = "Health-check a just-installed Splanc bridge system (commit or roll back)";
      wantedBy = [ "multi-user.target" ];
      after = [ "splanc-bridge.service" "splanc-display.service" "NetworkManager.service" "local-fs.target" ];
      inherit path;
      environment = env;
      restartIfChanged = false;
      unitConfig.ConditionPathExists = "/var/lib/splanc-system-update/state.json";
      serviceConfig = {
        # Not a oneshot: the health check takes minutes and must not hold up
        # multi-user.target (or "is-system-running" -- one of the checks).
        Type = "exec";
        StateDirectory = "splanc-system-update";
        StateDirectoryMode = "0700";
        ExecStart = lib.escapeShellArgs (py ++ [ "confirm" ]);
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
      };
    };
  };
}
