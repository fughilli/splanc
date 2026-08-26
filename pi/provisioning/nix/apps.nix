# LED Mapper application units, declared via sbc-deploy's generic
# `services.sbcApps` module. The two long-lived Pi processes from the design doc
# §3:
#   * led-driver (M1) — owns the SPI bus + pattern clock (realtime).
#   * led-server (M2) — FastAPI/uvicorn web server; depends on the driver's
#     control socket, binds :80, serves the web app.
#
# M1 (led-driver) is now a REAL package: the //pi/led_driver app run over
# hardware SPI. M2 (led-server) is still an inert stub. The unit shape, service
# user, dirs, capabilities, and firewall openings here are already correct.
{ pkgs, ... }:
let
  # The driver's only runtime deps: spidev (native, lazy-imported, Pi-only) and
  # pydantic v2 (ledmapper_protocol's models). Everything else is stdlib.
  ledPyEnv = pkgs.python3.withPackages (ps: [ ps.spidev ps.pydantic ]);

  # Output backend baked into this image. The Pi3 test board (splanc-max-2) drives
  # the //fpga/spi_ws281x streaming WS281x FPGA over SPI; the Pi5 (splanc-max-1)
  # can revert to APA102 strips by flipping ledOutput back to "apa102". --start N
  # self-drives a default cycle at boot so the SPI wire is always active for the
  # logic-analyzer probe (//pi/tools/la_probe) without needing a client.
  ledOutput = "fpga";
  ledFpgaPorts = 4;
  ledStartLeds = 2200; # 4 ports x 550 LEDs (60Hz max-length HITL case)
  ledFps = 60;

  # Sources are VENDORED under ./ledapp because the deploy builds the flake as
  # `path:pi/provisioning/nix`, whose tree can't reach ../../{pi/led_driver,
  # shared/protocol}. TODO: bazel-generate ./ledapp from the canonical sources +
  # a sync test (mirrors //pi/hitl/internal/skus) to prevent drift.
  ledDriverPkg = pkgs.runCommand "led-mapper-driver"
    { nativeBuildInputs = [ pkgs.makeWrapper ]; }
    ''
      mkdir -p "$out/bin" "$out/libexec"
      cp -r ${./ledapp}/. "$out/libexec/"
      makeWrapper ${ledPyEnv}/bin/python3 "$out/bin/led-driver" \
        --set PYTHONPATH "$out/libexec" \
        --set PYTHONUNBUFFERED 1 \
        --add-flags "-m led_driver" \
        --add-flags "--output ${ledOutput}" \
        --add-flags "--fpga-ports ${toString ledFpgaPorts}" \
        --add-flags "--start ${toString ledStartLeds}" \
        --add-flags "--fps ${toString ledFps}"
    '';

  # FPGA gateware shipped in this image; the DUT flashes its own Tang Nano 9K
  # over USB-JTAG before the player opens SPI (openFPGALoader + udev in fpga.nix).
  #
  # The bitstream comes from Bazel (//fpga/spi_ws281x:spi_ws281x_tangnano9k), not
  # committed. Preferred: SBC_FPGA_BITSTREAM exported to the --impure eval (the
  # data-dependency path — needs sbc-deploy to add it to its env passthrough, the
  # way it exports SBC_DEPLOY_PUBKEY_FILE; TODO). Until then it falls back to a
  # gitignored ./fpga/spi_ws281x.fs that the deploy copies from bazel-bin (see
  # fpga/README.md) — Bazel-built, just not yet a single-command data dep.
  fpgaBitstreamEnv = builtins.getEnv "SBC_FPGA_BITSTREAM";
  fpgaBitstream =
    if fpgaBitstreamEnv != "" && builtins.pathExists (/. + fpgaBitstreamEnv)
    then builtins.path { path = /. + fpgaBitstreamEnv; name = "spi_ws281x.fs"; }
    else ./fpga/spi_ws281x.fs;
  fpgaCommission = pkgs.writeShellScript "fpga-commission" ''
    echo "[fpga-commission] loading gateware onto the Tang Nano 9K" >&2
    # SRAM load (volatile): the deployed bitstream is (re)applied on every player
    # start, so the FPGA always matches this image. -f would persist to the
    # board's SPI flash instead (slower, wears flash, survives power cycles).
    # NON-FATAL during bring-up: log + continue so a DUT without a (working) Tang
    # still boots the player. Flip to required (exit on failure) once validated.
    if ${pkgs.openfpgaloader}/bin/openFPGALoader -b tangnano9k ${fpgaBitstream}; then
      echo "[fpga-commission] done" >&2
    else
      echo "[fpga-commission] FAILED (rc=$?) — continuing without a fresh FPGA" >&2
    fi
    exit 0
  '';

  ledServerPkg = pkgs.writeShellScriptBin "led-server" ''
    echo "led-server placeholder — M2 (pi/server:serve) not packaged yet" >&2
    exec sleep infinity
  '';

  webAppPkg = pkgs.runCommand "led-mapper-web" { } ''
    mkdir -p "$out"
    cat > "$out/index.html" <<'EOF'
    <!doctype html><meta charset=utf-8>
    <title>LED Mapper</title>
    <h1>LED Mapper</h1>
    <p>Web app placeholder — built web/ not baked in yet.</p>
    EOF
  '';
in
{
  services.sbcApps = {
    # M1 — pattern driver. Real-time FIFO scheduling + CAP_SYS_NICE, owns SPI,
    # exposes the control socket under /run/ledmapper. Creates the shared
    # `ledmapper` service user (member of spi/gpio via extraGroups).
    led-driver = {
      description = "LED Mapper pattern driver (M1) — SPI / pattern clock";
      package = ledDriverPkg;
      exec = "bin/led-driver";
      user = "ledmapper";
      extraGroups = [ "spi" "gpio" ];
      realtime = true;
      runtimeDirectory = "ledmapper";
      readWritePaths = [ "/run/ledmapper" ];
      after = [ "local-fs.target" ];
      # Commission the FPGA (flash the Tang Nano over USB) BEFORE streaming SPI,
      # only when driving the FPGA. `+` runs it as root (bypasses the
      # User=ledmapper sandbox) so it can claim the USB device; the player's own
      # ExecStart then opens /dev/spidev. Gating keeps the apa102 path (and its
      # bare eval) from needing SBC_FPGA_BITSTREAM.
      extraServiceConfig = pkgs.lib.optionalAttrs (ledOutput == "fpga") {
        ExecStartPre = "+${fpgaCommission}";
      };
    };

    # M2 — web server. Reuses the driver's `ledmapper` user, binds :80, persists
    # sessions under /var/lib/ledmapper, starts after the driver.
    led-server = {
      description = "LED Mapper web server (M2) — FastAPI/uvicorn + websocket";
      package = ledServerPkg;
      exec = "bin/led-server";
      user = "ledmapper";
      createUser = false; # reuse the driver's user/group
      ports = [ 80 ];
      bindPrivilegedPorts = true;
      runtimeDirectory = "ledmapper";
      stateDirectory = "ledmapper/sessions";
      readWritePaths = [ "/var/lib/ledmapper" "/run/ledmapper" ];
      after = [ "network.target" "sbc-led-driver.service" ];
      wants = [ "sbc-led-driver.service" ];
      environment = {
        LEDMAPPER_WEB_ROOT = toString webAppPkg;
        LEDMAPPER_CONTROL_SOCKET = "/run/ledmapper/control.sock";
        LEDMAPPER_SESSION_DIR = "/var/lib/ledmapper/sessions";
        LEDMAPPER_PORT = "80";
      };
    };
  };
}
