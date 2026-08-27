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
{ pkgs, sbcBuildData ? { }, ... }:
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

  # The Rust player (//pi/player_rs:player) — the unified aarch64/std sibling of
  # the ESP32 firmware: ONE process that serves the protocol over WSS AND drives
  # the FPGA from the reused core, replacing the Python M1 driver + M2 server on
  # the FPGA path. A fully-STATIC aarch64-linux-musl binary
  # (//pi/player_rs/musl:player_musl), cross-compiled by rustc alone (100% Rust,
  # no C) and shipped through the build graph as build_data (keyed by basename
  # "player") — no staged prebuilt, and static so it runs on NixOS with NO loader
  # and NO patchelf.
  playerRsWssPort = 8443;
  playerRsBin = sbcBuildData."player" or (throw
    "player binary missing from build_data — add //pi/player_rs/musl:player_musl "
  + "to sbc_application(build_data=…).");
  playerRsPkg = pkgs.runCommand "led-mapper-player-rs"
    { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    install -Dm755 ${playerRsBin} "$out/libexec/player"
    makeWrapper "$out/libexec/player" "$out/bin/player" \
      --add-flags "--fpga-ports ${toString ledFpgaPorts}" \
      --add-flags "--start ${toString ledStartLeds}" \
      --add-flags "--fps ${toString ledFps}" \
      --add-flags "--serve-port ${toString playerRsWssPort}"
  '';

  # FPGA gateware shipped in this image; the DUT flashes its own Tang Nano 9K
  # over USB-JTAG before the player opens SPI (openFPGALoader + udev in fpga.nix).
  #
  # The bitstream is a Bazel data dependency, injected through sbc-deploy's
  # generic `build_data` (//pi/provisioning:BUILD -> sbcBuildData, keyed by
  # basename). Not vendored, not copied — Bazel builds //fpga/spi_ws281x and the
  # deploy hands it to the flake. Only forced on the FPGA path (commission is
  # gated below), so the apa102 path / bare eval needs nothing.
  fpgaBitstream = sbcBuildData."spi_ws281x_tangnano9k.fs" or
    (throw "spi_ws281x bitstream missing from build_data — add "
      + "//fpga/spi_ws281x:spi_ws281x_tangnano9k to sbc_application(build_data=…).");
  # Where the gateware sha STAMP lives in the Tang's 4MB external SPI flash: 3MB
  # in, well past the ~0.6MB bitstream (offset 0), in its own 64KB sector.
  fpgaStampOffset = "0x300000";
  fpgaCommission = pkgs.writeShellScript "fpga-commission" ''
    # Commission the Tang on every boot, only (re)flashing when its gateware
    # actually differs — so a persistent flash (survives power cycles) isn't
    # recycled needlessly. The decision is a sha STAMP written into the FPGA's
    # OWN SPI flash and read back off the board, so it is fully BOARD-authoritative
    # and needs ZERO Pi-side state: a reimaged/fresh Pi, a swapped board, and a
    # blank board all resolve correctly (unlike a Pi-side marker, which can't see
    # any of those). The stamp is the sha256 of the flashed .fs.
    #
    # openFPGALoader can read/write arbitrary flash offsets on the Tang with NO
    # patch — its Gowin raw-write path is just gated behind --external-flash (the
    # Tang's config flash IS that external SPI chip). Reads are tiny (64B) so
    # they're ~instant despite the Tang's slow (~100 B/s) flash read.
    ofl=${pkgs.openfpgaloader}/bin/openFPGALoader
    sha=${pkgs.coreutils}/bin/sha256sum
    want=${fpgaBitstream}
    off=${fpgaStampOffset}
    wantsha=$($sha "$want" | cut -c1-64)

    read_stamp() {
      local d; d=$(mktemp)
      if $ofl -b tangnano9k --freq 10000000 --external-flash --dump-flash \
            -o "$off" --file-size 64 "$d" >/dev/null 2>&1; then
        LC_ALL=C tr -cd '0-9a-f' < "$d" | head -c 64
      fi
      rm -f "$d"
    }

    if [ "$(read_stamp)" = "$wantsha" ]; then
      echo "[fpga-commission] Tang already holds this gateware (stamp match) — skipping" >&2
      exit 0
    fi

    echo "[fpga-commission] flashing gateware onto the Tang Nano 9K" >&2
    # NON-FATAL during bring-up: log + continue so a DUT without a (working) Tang
    # still boots the player. Flip to required (exit on failure) once validated.
    if $ofl -b tangnano9k -f "$want"; then
      # Stamp the board so the next boot can skip. Best-effort: a missing/failed
      # stamp only costs a reflash next boot, never a wrong "skip".
      s=$(mktemp); printf '%s' "$wantsha" > "$s"
      if $ofl -b tangnano9k --freq 10000000 --external-flash -f \
            -o "$off" --file-type raw "$s" >/dev/null 2>&1; then
        echo "[fpga-commission] done (stamped $wantsha)" >&2
      else
        echo "[fpga-commission] flashed, but stamp write failed — will reflash next boot" >&2
      fi
      rm -f "$s"
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
      # On the FPGA path this is the unified Rust player (WSS protocol + FPGA
      # render, the firmware's model); the apa102 path keeps the Python M1 driver
      # (the Rust render loop is FPGA-only so far). The unit name stays
      # sbc-led-driver.service for continuity (HITL harness restarts it).
      description = "LED Mapper player — WSS protocol + LED render";
      package = if ledOutput == "fpga" then playerRsPkg else ledDriverPkg;
      exec = if ledOutput == "fpga" then "bin/player" else "bin/led-driver";
      user = "ledmapper";
      extraGroups = [ "spi" "gpio" ];
      realtime = true;
      # The Rust player serves WSS on this port (the phone + HITL harness reach it
      # over the net, via res.forward on the rig); opens the firewall.
      ports = pkgs.lib.optionals (ledOutput == "fpga") [ playerRsWssPort ];
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
