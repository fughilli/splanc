# The Splanc bridge appliance: `splanc-agent bridge` + the HDMI/OLED screens +
# agent self-update. Board-independent (nix/rpi.nix has the Raspberry Pi bits),
# so the QEMU smoke test (nix/vm-test.nix) runs exactly this module.
#
# Mirrors pi/bridge/systemd/*.service (the Raspberry Pi OS install.sh path) with
# the image's paths:
#
#   splanc-bridge.service       the bridge (Node), as `splanc`; runs the newest
#                               verified bundle in /var/lib/splanc-agent/current,
#                               else the one baked into the image
#   splanc-display.service      pi/bridge/display on /dev/fb0 (VT 8) + the OLED HAT
#   splanc-agent-update.timer   ~2 min after boot, then daily: fetch
#                               splanc.io/agent/latest.json, verify the bundle's
#                               sha256, switch, restart the bridge (as the
#                               `splanc-update` user: the bridge can't modify the
#                               code it runs)
#
# State that survives reboots: /var/lib/splanc-bridge (bridge.json identity, hub
# config) and /var/lib/splanc-agent (updated bundles). Settings come from the
# boot partition each boot (nix/flash-config.nix -> /run/splanc-flash/bridge.env).
{ config, lib, pkgs, ... }:
let
  cfg = config.splancBridge;
  bp = pkgs.callPackage ./packages.nix { };
  node = pkgs.nodejs-slim_22;
  agentState = "/var/lib/splanc-agent";
  statusFile = "/run/splanc-bridge/status.json";
  controlSock = "/run/splanc-bridge/control.sock";
  envFile = "/run/splanc-flash/bridge.env";

  # ExecStart of splanc-bridge.service. A bundle that predates `splanc-agent
  # bridge` (anything before the cloud-relay release) can't run it: say so on
  # the screens (via status.json) and wait for the updater to bring a newer one.
  bridgeRun = pkgs.writeShellScript "splanc-bridge-run" ''
    set -u
    PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnugrep ]}
    pick() {
      if [ -f ${agentState}/current/mcp/splanc-agent.mjs ]; then
        agent=${agentState}/current
      else
        agent=${bp.agentBundle}
      fi
    }
    pick
    while ! grep -q 'bridge-ctl' "$agent/mcp/splanc-agent.mjs"; do
      ver="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$agent/bundle.json" | head -n1)"
      tmp="$SPLANC_BRIDGE_STATUS.tmp"
      printf '{"v":1,"state":"error","error":"Splanc agent %s has no bridge yet. Checking for an update...","updated_at":%s}\n' \
        "$ver" "$(date +%s)" >"$tmp" && mv -f "$tmp" "$SPLANC_BRIDGE_STATUS"
      echo "splanc-bridge: agent $ver predates the bridge; waiting for an update" >&2
      sleep 120
      pick
    done
    set --
    if [ -n "''${SPLANC_RELAY:-}" ]; then set -- --relay "$SPLANC_RELAY"; fi
    exec ${node}/bin/node "$agent/mcp/splanc-agent.mjs" bridge "$@"
  '';

  # `splanc-bridge` on the console / over SSH (status, new-code, logs, update ...).
  cli = pkgs.writeShellScriptBin "splanc-bridge" ''
    set -eu
    case "''${1:-status}" in
      status | new-code | identify | revoke-all)
        SPLANC_BRIDGE_STATUS=${statusFile} SPLANC_BRIDGE_CONTROL=${controlSock} \
          PYTHONPATH=${bp.splancPy} exec ${bp.pyEnv}/bin/python3 -m splanc_display.ctl "$@" ;;
      logs) shift; exec journalctl -u splanc-bridge -u splanc-display -u splanc-agent-update -u splanc-flash-config --no-pager -n 200 "$@" ;;
      update) exec systemctl start splanc-agent-update.service ;;
      restart) exec systemctl restart splanc-bridge.service splanc-display.service ;;
      version) cat /etc/splanc-bridge/image.json; echo; readlink ${agentState}/current || echo "agent: baked ${bp.agentBundle.version}" ;;
      *) echo "usage: splanc-bridge [status|new-code|identify|revoke-all|logs|update|restart|version]" >&2; exit 2 ;;
    esac
  '';

  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    RestrictNamespaces = true;
    RestrictRealtime = true;
    LockPersonality = true;
  };
in
{
  options.splancBridge = {
    board = lib.mkOption {
      type = lib.types.str;
      default = "generic";
      description = "Board key (pi3, pi4, pi5, zero2w); recorded in /etc/splanc-bridge/image.json.";
    };
    imageRev = lib.mkOption {
      type = lib.types.str;
      default = "unknown";
      description = "Source revision of the image build.";
    };
    latestUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://splanc.io/agent/latest.json";
      description = "Release pointer the agent self-update follows.";
    };
    updaterExtraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true; # the VM test points the updater at a local http server
    };
  };

  config = {
    networking.hostName = lib.mkDefault "splanc-bridge";
    # The app's direct LAN endpoint for live VJ (`splanc-agent bridge --live-port`,
    # default 8443; docs/design/live-vj-relay.md). TLS + a ticket minted via the relay.
    networking.firewall.allowedTCPPorts = [ 8443 ];

    # Nobody logs in: no passwords anywhere. SSH (root, key-only) exists only when
    # the boot partition carries an authorized_keys file (see services.openssh).
    users.mutableUsers = false;
    users.allowNoPasswordLogin = true;
    users.groups.splanc = { };
    users.users.splanc = {
      isSystemUser = true;
      group = "splanc";
      home = "/var/lib/splanc-bridge";
      extraGroups = [ "video" "tty" "gpio" "spi" "i2c" ];
    };
    users.users.splanc-update = {
      isSystemUser = true;
      group = "splanc";
    };
    users.groups.gpio = { };
    users.groups.spi = { };
    users.groups.i2c = { };

    environment.systemPackages = [ cli ];
    environment.etc."splanc-bridge/image.json".text = builtins.toJSON {
      inherit (cfg) board;
      rev = cfg.imageRev;
      agent_baked = bp.agentBundle.version;
      latest = cfg.latestUrl;
    };

    systemd.services.splanc-bridge = {
      description = "Splanc cloud bridge";
      documentation = [ "https://github.com/fughilli/splanc/blob/main/docs/pi-bridge.md" ];
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" "splanc-flash-config.service" ];
      unitConfig.StartLimitIntervalSec = 0;
      environment = {
        SPLANC_BRIDGE_STATUS = statusFile;
        SPLANC_BRIDGE_CONTROL = controlSock;
        SPLANC_CONFIG_DIR = "/var/lib/splanc-bridge/config";
        SPLANC_CACHE_DIR = "/var/cache/splanc-bridge";
        HOME = "/var/lib/splanc-bridge";
        NODE_ENV = "production";
      };
      serviceConfig = hardening // {
        Type = "simple";
        User = "splanc";
        Group = "splanc";
        EnvironmentFile = "-${envFile}";
        ExecStart = bridgeRun;
        RuntimeDirectory = "splanc-bridge";
        RuntimeDirectoryMode = "0750";
        UMask = "0007";
        StateDirectory = "splanc-bridge";
        StateDirectoryMode = "0700";
        CacheDirectory = "splanc-bridge";
        Restart = "always";
        RestartSec = 5;
        PrivateDevices = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK" ];
      };
    };

    systemd.services.splanc-display = {
      description = "Splanc bridge screens (HDMI + OLED HAT)";
      wantedBy = [ "multi-user.target" ];
      after = [ "splanc-bridge.service" "systemd-user-sessions.service" "splanc-flash-config.service" ];
      unitConfig.StartLimitIntervalSec = 0;
      environment = {
        SPLANC_BRIDGE_STATUS = statusFile;
        SPLANC_BRIDGE_CONTROL = controlSock;
        PYTHONPATH = "${bp.splancPy}";
        PYTHONUNBUFFERED = "1";
        PYTHONDONTWRITEBYTECODE = "1";
        SPLANC_DISPLAY_FONT_DIR = "${bp.fonts}";
        GPIOZERO_PIN_FACTORY = "lgpio";
        LG_WD = "/run/splanc-display";
      };
      serviceConfig = hardening // {
        Type = "simple";
        User = "splanc";
        Group = "splanc";
        EnvironmentFile = "-${envFile}";
        WorkingDirectory = "/run/splanc-display";
        RuntimeDirectory = "splanc-display";
        ExecStart = "${bp.pyEnv}/bin/python3 -m splanc_display.main";
        # Below the bridge: animation frames never take CPU or I/O from its network work.
        Nice = 10;
        IOSchedulingClass = "idle";
        # Switch to VT 8 and put it in graphics mode so the console doesn't draw over us.
        AmbientCapabilities = [ "CAP_SYS_TTY_CONFIG" ];
        CapabilityBoundingSet = [ "CAP_SYS_TTY_CONFIG" ];
        Restart = "always";
        RestartSec = 3;
        RestrictAddressFamilies = [ "AF_UNIX" ];
      };
    };

    systemd.services.splanc-agent-update = {
      description = "Update the Splanc agent bundle (splanc.io/agent/latest.json)";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" "time-sync.target" "splanc-flash-config.service" ];
      environment = {
        SPLANC_AGENT_BAKED = "${bp.agentBundle}";
        SPLANC_LATEST_URL = cfg.latestUrl;
        PYTHONPATH = "${bp.splancPy}";
        PYTHONDONTWRITEBYTECODE = "1";
      };
      serviceConfig = hardening // {
        Type = "oneshot";
        User = "splanc-update";
        Group = "splanc";
        EnvironmentFile = "-${envFile}";
        StateDirectory = "splanc-agent";
        StateDirectoryMode = "0755";
        UMask = "0022";
        ExecStart = lib.escapeShellArgs ([ "${bp.pyEnv}/bin/python3" "-m" "splanc_image.selfupdate" "--auto" ] ++ cfg.updaterExtraArgs);
        # "+": as root, to restart the bridge onto the new bundle.
        ExecStartPost = "+${pkgs.writeShellScript "splanc-agent-updated" ''
          if [ -e ${agentState}/.updated ]; then
            ${pkgs.coreutils}/bin/rm -f ${agentState}/.updated
            ${config.systemd.package}/bin/systemctl try-restart splanc-bridge.service
          fi
        ''}";
        # No network yet / splanc.io unreachable: try again in a while.
        Restart = "on-failure";
        RestartSec = "15min";
        PrivateDevices = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      };
    };

    systemd.timers.splanc-agent-update = {
      description = "Check for a new Splanc agent bundle";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        # No RandomizedDelaySec: it also delays the first check after boot (up to
        # 30 min), and a freshly flashed card may need that update to be usable.
        OnBootSec = "2min";
        OnUnitActiveSec = "1d";
      };
    };

    # mDNS: sbc-base turns on avahi; NetworkManager must not rename the host (the
    # flash-config service sets it from the boot partition).
    networking.networkmanager.settings.main.hostname-mode = "none";
    # brcmfmac power save drops packets / stalls the relay link.
    networking.networkmanager.wifi.powersave = false;

    # Optional SSH (power users): key-only root login, and sshd only runs when the
    # flasher (or the user) put an authorized_keys file on the boot partition.
    services.openssh = {
      enable = true;
      openFirewall = true;
      authorizedKeysFiles = [ "/var/lib/splanc-ssh/authorized_keys" ];
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "prohibit-password";
        AllowUsers = [ "root" ];
      };
    };
    systemd.services.sshd = {
      after = [ "splanc-flash-config.service" ];
      unitConfig.ConditionPathExists = "/var/lib/splanc-ssh/authorized_keys";
    };

    # Read-mostly: keep the SD card's write load low. The root stays ext4 rw (the
    # first boot grows it and registers the store; a true read-only root would need
    # an overlay and isn't worth it for this) but logs live in RAM, /tmp is tmpfs
    # and nothing updates atime.
    services.journald.storage = "volatile";
    services.journald.extraConfig = "RuntimeMaxUse=32M";
    boot.tmp.useTmpfs = true;
    fileSystems."/".options = [ "noatime" ];
    # 512 MB boards (Zero 2 W, Pi 3 A+): compressed RAM swap instead of SD swap.
    zramSwap.enable = true;

    time.timeZone = "UTC";
    i18n.defaultLocale = "C.UTF-8";
    i18n.supportedLocales = [ "C.UTF-8/UTF-8" ];
    system.stateVersion = "25.05";
  };
}
