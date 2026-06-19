# LED Mapper application module.
#
# Defines the two long-lived Pi processes from the design doc §3:
#   * led-driver  (M1) — owns the SPI bus and the pattern clock.
#   * led-server  (M2) — FastAPI/uvicorn web server; serves the web app +
#                        websocket, invokes M3 reconstruction as a subprocess.
#
# M1 and M2 are NOT BUILT YET. This module wires up the systemd units, the
# service user, the runtime directories, and the static web-app serving path
# as clean seams/placeholders so that when M1/M2/web land, only the package
# derivations need to be filled in (see the `placeholder` derivations below).
{ config, lib, pkgs, ... }:

let
  cfg = config.services.ledMapper;

  # ---------------------------------------------------------------------------
  # PLACEHOLDER PACKAGES.
  #
  # When M1 (pi/led_driver), M2 (pi/server), and the web app (web/) are built,
  # replace these with real derivations — either packaged here from the Bazel
  # outputs, or referenced from a `packages.<system>` output of this flake that
  # consumes the Bazel-built artifacts. Until then these are inert stubs so the
  # systemd units and serving path exist and the seams are explicit.
  # ---------------------------------------------------------------------------
  ledDriverPkg = pkgs.writeShellScriptBin "led-driver" ''
    echo "led-driver placeholder — M1 not built yet" >&2
    # Real M1 owns /dev/spidev0.0 and runs the Gray-code cycle. It exposes a
    # local Unix socket at ${cfg.controlSocket} for M2.
    exec sleep infinity
  '';

  ledServerPkg = pkgs.writeShellScriptBin "led-server" ''
    echo "led-server placeholder — M2 not built yet" >&2
    # Real M2: uvicorn led_mapper.server:app --host 0.0.0.0 --port ${toString cfg.port}
    # serving static web app from ${cfg.webRoot} and WS /ws.
    exec sleep infinity
  '';

  webAppPkg = pkgs.runCommand "led-mapper-web" { } ''
    mkdir -p $out
    cat > $out/index.html <<'EOF'
    <!doctype html><meta charset=utf-8>
    <title>LED Mapper</title>
    <h1>LED Mapper</h1>
    <p>Web app placeholder — built web/ (M5-M8) not baked in yet.</p>
    EOF
  '';
in
{
  options.services.ledMapper = {
    enable = lib.mkEnableOption "LED Mapper Pi services (led-driver + led-server)";

    port = lib.mkOption {
      type = lib.types.port;
      default = 80;
      description = "HTTP port for the LED Mapper web server (M2).";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "ledmapper";
      description = "Service user for the LED Mapper processes.";
    };

    webRoot = lib.mkOption {
      type = lib.types.path;
      default = webAppPkg;
      description = ''
        Directory of static web-app files served by M2. Defaults to a
        placeholder; point at the built web/ output once it exists.
      '';
    };

    controlSocket = lib.mkOption {
      type = lib.types.str;
      default = "/run/ledmapper/control.sock";
      description = "Unix socket the led-driver exposes for the server (design doc §3).";
    };

    sessionDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/ledmapper/sessions";
      description = "Where M2 persists detection session logs (design doc §6 M2).";
    };

    ledDriverPackage = lib.mkOption {
      type = lib.types.package;
      default = ledDriverPkg;
      description = "M1 led-driver package. PLACEHOLDER until M1 is built.";
    };

    serverPackage = lib.mkOption {
      type = lib.types.package;
      default = ledServerPkg;
      description = "M2 server package. PLACEHOLDER until M2 is built.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      description = "LED Mapper service user";
      # SPI access needs the spi group (see modules/spi.nix udev rule).
      extraGroups = [ "spi" "gpio" ];
    };
    users.groups.${cfg.user} = { };

    # M1 — pattern driver. Real-time priority, owns SPI. Started first so the
    # control socket exists before the server tries to connect.
    systemd.services.led-driver = {
      description = "LED Mapper pattern driver (M1) — SPI / pattern clock";
      wantedBy = [ "multi-user.target" ];
      after = [ "local-fs.target" ];
      serviceConfig = {
        ExecStart = "${cfg.ledDriverPackage}/bin/led-driver";
        User = cfg.user;
        # Real-time scheduling for jitter-free SPI cadence (design doc §3, §13).
        CPUSchedulingPolicy = "fifo";
        CPUSchedulingPriority = 50;
        RuntimeDirectory = "ledmapper";
        RuntimeDirectoryMode = "0750";
        Restart = "on-failure";
        RestartSec = 2;
        # Hardening (relaxed where SPI/realtime needs it).
        AmbientCapabilities = [ "CAP_SYS_NICE" ];
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/run/ledmapper" ];
      };
    };

    # M2 — web server. Depends on the driver's control socket.
    systemd.services.led-server = {
      description = "LED Mapper web server (M2) — FastAPI/uvicorn + websocket";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "led-driver.service" ];
      wants = [ "led-driver.service" ];
      environment = {
        LEDMAPPER_WEB_ROOT = cfg.webRoot;
        LEDMAPPER_CONTROL_SOCKET = cfg.controlSocket;
        LEDMAPPER_SESSION_DIR = cfg.sessionDir;
        LEDMAPPER_PORT = toString cfg.port;
      };
      serviceConfig = {
        ExecStart = "${cfg.serverPackage}/bin/led-server";
        User = cfg.user;
        StateDirectory = "ledmapper/sessions";
        RuntimeDirectory = "ledmapper";
        Restart = "on-failure";
        RestartSec = 2;
        # Bind to :80 as an unprivileged user.
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/var/lib/ledmapper" "/run/ledmapper" ];
      };
    };

    # Make the placeholder packages discoverable for debugging.
    environment.systemPackages = [ cfg.ledDriverPackage cfg.serverPackage ];
  };
}
