# LED Mapper application units, declared via sbc-deploy's generic
# `services.sbcApps` module. The two long-lived Pi processes from the design doc
# §3:
#   * led-driver (M1) — owns the SPI bus + pattern clock (realtime).
#   * led-server (M2) — FastAPI/uvicorn web server; depends on the driver's
#     control socket, binds :80, serves the web app.
#
# M1 (led-driver) is one of two REAL packages, picked by `ledOutput`: the Rust
# player (//pi/player_rs) driving the spi_ws281x FPGA, or the Python APA102/SK9822
# driver (//pi/led_driver) over hardware SPI. Both render the hue code with the
# same Rust kernel (//firmware/pattern). M2 (led-server) is still an inert stub.
# The unit shape, service user, dirs, capabilities, and firewall openings here
# are already correct.
{ pkgs, sbcBuildData ? { }, ... }:
let
  # Output backend baked into this image. Both current test boards are Raspberry
  # Pi 3s: splanc-max-2 (the FPGA rig, Tang Nano 9K attached) drives the
  # //fpga/spi_ws281x streaming WS281x FPGA over SPI, and splanc-max-1 is the same
  # config. `fpga` needs the Tang wired to the board; a board without one runs
  # APA102/SK9822 strips with ledOutput = "apa102" (the Python driver, clock+data
  # straight off hardware SPI). Flip the default here, or per build with
  # SPLANC_LED_OUTPUT=apa102 (read --impure, like every sbc-deploy seam). (The
  # Pi 3/Pi 5 split is a BOARD choice, not tied to a specific host — deploy the
  # matching sbc_application variant; deploy_live's board guard refuses a
  # mismatched closure.) --start N self-drives a default cycle at boot so the SPI
  # wire is always active for the logic-analyzer probe (//pi/tools/la_probe)
  # without needing a client.
  ledOutputEnv = builtins.getEnv "SPLANC_LED_OUTPUT";
  ledOutput =
    let o = if ledOutputEnv == "" then "fpga" else ledOutputEnv; in
    if builtins.elem o [ "fpga" "apa102" ] then o
    else throw "ledOutput \"${o}\": expected \"fpga\" (Rust player + FPGA) or \"apa102\" (Python APA102/SK9822 driver)";
  ledFpgaPorts = 4;
  ledStartLeds = 2200; # 4 ports x 550 LEDs (60Hz max-length HITL case)
  ledFps = 60;

  # --- apa102: the Python M1 driver (//pi/led_driver) -------------------------
  # Its runtime deps: spidev (native, lazy-imported, Pi-only) and pydantic v2
  # (ledmapper_protocol's models). Everything else is stdlib.
  ledPyEnv = pkgs.python3.withPackages (ps: [ ps.spidev ps.pydantic ]);

  # The driver's sources arrive as ONE Bazel build_data file,
  # //pi/led_driver:ledapp_bundle (the deploy builds the flake as
  # `path:pi/provisioning/nix`, whose tree can't reach the repo): led_driver/,
  # ledmapper_protocol/, the kernel binding ledmapper_pattern.py and the hue-code
  # kernel's Rust sources kernel/{lib,kernel_abi}.rs. Nothing is vendored here.
  ledAppBundle = sbcBuildData."ledapp.tar" or (throw
    "APA102 driver bundle missing from build_data — add //pi/led_driver:ledapp_bundle "
  + "to sbc_application(build_data=…).");

  # The hue-code kernel's C ABI as a native cdylib — the SAME crate + shim
  # (//firmware/pattern:kernel_abi) the Bazel side builds for the dev backend,
  # compiled here by rustc (no_std crate, zero deps; the shim links std, so the
  # cdylib link needs cc: runCommandCC).
  # The driver renders every pattern frame through it, so the APA102 path has no
  # copy of the colour code. Built for the image's own platform (the closure is
  # built natively on aarch64, like the rest of the system).
  ledPatternKernel = pkgs.runCommandCC "ledmapper-pattern-kernel"
    { nativeBuildInputs = [ pkgs.rustc ]; } ''
    tar -xf ${ledAppBundle} kernel/lib.rs kernel/kernel_abi.rs
    rustc --edition 2021 --crate-type rlib --crate-name ledmapper_pattern \
      --cfg 'feature="app"' -C opt-level=3 \
      -o libledmapper_pattern.rlib kernel/lib.rs
    mkdir -p "$out/lib"
    rustc --edition 2021 --crate-type cdylib --crate-name ledmapper_pattern_abi \
      -C opt-level=3 --extern ledmapper_pattern=libledmapper_pattern.rlib \
      -o "$out/lib/libledmapper_pattern_abi.so" kernel/kernel_abi.rs
  '';

  ledDriverPkg = pkgs.runCommand "led-mapper-driver"
    { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    mkdir -p "$out/bin" "$out/libexec"
    tar -xf ${ledAppBundle} -C "$out/libexec" --exclude 'kernel/*'
    # Smoke: the driver renders a kernel frame (fails the build, not the boot).
    LEDMAPPER_PATTERN_LIB=${ledPatternKernel}/lib/libledmapper_pattern_abi.so \
      PYTHONPATH="$out/libexec" ${ledPyEnv}/bin/python3 -c \
      'from led_driver.pattern import color_plan, default_code_params as d; assert len(color_plan(d(16))) == 12'
    makeWrapper ${ledPyEnv}/bin/python3 "$out/bin/led-driver" \
      --set PYTHONPATH "$out/libexec" \
      --set PYTHONUNBUFFERED 1 \
      --set LEDMAPPER_PATTERN_LIB ${ledPatternKernel}/lib/libledmapper_pattern_abi.so \
      --add-flags "-m led_driver" \
      --add-flags "--output ${ledOutput}" \
      --add-flags "--fpga-ports ${toString ledFpgaPorts}" \
      --add-flags "--start ${toString ledStartLeds}" \
      --add-flags "--fps ${toString ledFps}"
  '';

  # --- fpga: the Rust player ------------------------------------------------
  # The Rust player (//pi/player_rs:player) — the unified aarch64/std sibling of
  # the ESP32 firmware: ONE process that serves the protocol over WSS AND drives
  # the FPGA from the reused core, replacing the Python M1 driver + M2 server on
  # the FPGA path. A fully-STATIC aarch64-linux-musl binary
  # (//pi/player_rs/musl:player_musl), cross-compiled by rustc alone (100% Rust,
  # no C) and shipped through the build graph as build_data (keyed by basename
  # "player") — no staged prebuilt, and static so it runs on NixOS with NO loader
  # and NO patchelf.
  playerRsWssPort = 8443;
  # HITL test images (docs/design/max-ota.md "HITL"): SPLANC_MAX_VARIANT=unhealthy
  # builds a player that runs but never writes its health file, so the updater's
  # trial check must roll it back. Read --impure, like every sbc-deploy seam.
  maxVariant = builtins.getEnv "SPLANC_MAX_VARIANT";
  unhealthyFlags = pkgs.lib.optionalString (maxVariant == "unhealthy") " --add-flags \"--health-file ''\"";

  # Output pacing + userspace real-time (pi/player_rs pacing.rs / rt.rs; README
  # "Frame-done pacing"). Frame-done: FPGA pin 28 -> Pi GPIO 22 (header pin 15),
  # 3.3 V both sides. The player waits for its rising edge per frame and falls
  # back to timed pacing by itself when the line never rises (unwired, old
  # bitstream), so the flag is safe on every board. "none" disables it.
  playerFrameDoneGpio = "22";
  # The output thread runs SCHED_FIFO 45 pinned to the last CPU, with
  # mlockall; the unit grants CAP_SYS_NICE + CAP_IPC_LOCK (below) instead of root.
  # The SPI controller's message-pump kthread goes to FIFO 46: just above the
  # output thread that blocks on it, below the IRQ threads (50).
  playerRtPrio = 45;
  spiPumpPrio = 46;
  # OPTIONAL (default off): keep the scheduler's load balancing, unbound
  # kworkers and IRQs off the output CPU (3 on every quad-core Pi). Costs that
  # core for the FX VM's 4-core fallback; only worth it if measurements under
  # load show interference the FIFO priority alone doesn't remove.
  isolateOutputCpu = false;
  outputCpu = 3;
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
      --add-flags "--serve-port ${toString playerRsWssPort}"${unhealthyFlags} \
      --add-flags "--frame-done-gpio ${playerFrameDoneGpio}" \
      --add-flags "--rt on --rt-prio ${toString playerRtPrio} --rt-cpu ${toString outputCpu}"
  '';

  # Raise the SPI controller's message-pump kthread. The spi core names it after
  # the controller device: `spi0` for SPI0 on the Pi 3/4 (spi-bcm2835) and on the
  # Pi 5 (RP1's DesignWare SPI, spi-dw-mmio). Runs as root (ExecStartPre=+).
  # Since ~6.0 an uncontended spi_sync runs in the CALLER's context (the output
  # thread), so the pump matters only when transfers queue; the raise keeps a
  # queued transfer from waiting behind normal tasks. Best-effort, never fatal.
  spiPumpRt = pkgs.writeShellScript "spi-pump-rt" ''
    for p in /proc/[0-9]*; do
      if [ "$(cat "$p/comm" 2>/dev/null)" = spi0 ]; then
        ${pkgs.util-linux}/bin/chrt -f -p ${toString spiPumpPrio} "''${p#/proc/}" \
          && echo "[spi-pump-rt] spi0 (pid ''${p#/proc/}) -> SCHED_FIFO ${toString spiPumpPrio}" >&2
      fi
    done
    exit 0
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

    # Cold boot races USB enumeration: the unit can start before the Tang's
    # FT2232 (0403:6010) is on the bus (hitl-rig-1, 2026-11-12: "unable to open
    # ftdi device: -3" -> stale/no gateware). Wait up to 20 s for it to appear;
    # still non-fatal if it never does.
    ft2232_present() {
      for d in /sys/bus/usb/devices/*; do
        [ "$(cat "$d/idVendor" 2>/dev/null)" = 0403 ] &&
          [ "$(cat "$d/idProduct" 2>/dev/null)" = 6010 ] && return 0
      done
      return 1
    }
    waited=0
    while ! ft2232_present && [ "$waited" -lt 40 ]; do
      sleep 0.5; waited=$((waited + 1))
    done
    if ft2232_present; then
      [ "$waited" -gt 0 ] && echo "[fpga-commission] Tang FT2232 enumerated after $((waited / 2)) s" >&2
    else
      echo "[fpga-commission] Tang FT2232 (0403:6010) not on USB after 20 s — trying anyway" >&2
    fi

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
    # Invalidate the stamp FIRST: a power cut mid-flash must not leave the previous
    # gateware's stamp next to a half-written bitstream (the next boot — e.g. an OTA
    # rollback to that previous system — would then skip the flash). Zeros never
    # match a sha256.
    z=$(mktemp); printf '%064d' 0 > "$z"
    $ofl -b tangnano9k --freq 10000000 --external-flash -f \
      -o "$off" --file-type raw "$z" >/dev/null 2>&1 || true
    rm -f "$z"
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
  # One FPGA frame is a single spidev write: 4 ports x 550 LEDs is a ~6.6 KB STREAM,
  # past spidev's 4 KiB default buffer, which fails every write (EMSGSIZE) — the
  # player rendered but the Tang got nothing. (Found by the OTA health check, which
  # counts frames actually written: docs/design/max-ota.md "Health proof".)
  boot.kernelParams = pkgs.lib.optionals (ledOutput == "fpga") [ "spidev.bufsiz=65536" ]
    ++ pkgs.lib.optionals isolateOutputCpu [
    "isolcpus=${toString outputCpu}"
    "irqaffinity=0-${toString (outputCpu - 1)}"
  ];

  services.sbcApps = {
    # M1 — pattern driver. Real-time FIFO scheduling + CAP_SYS_NICE, owns SPI,
    # exposes the control socket under /run/ledmapper. Creates the shared
    # `ledmapper` service user (member of spi/gpio via extraGroups).
    led-driver = {
      # On the FPGA path this is the unified Rust player (WSS protocol + FPGA
      # render, the firmware's model); the apa102 path runs the Python M1 driver
      # (the Rust render loop is FPGA-only so far). Both render the hue code with
      # the one Rust kernel. The unit name stays sbc-led-driver.service for
      # continuity (HITL harness restarts it).
      description = "LED Mapper player — WSS protocol + LED render";
      package = if ledOutput == "fpga" then playerRsPkg else ledDriverPkg;
      exec = if ledOutput == "fpga" then "bin/player" else "bin/led-driver";
      user = "ledmapper";
      extraGroups = [ "spi" "gpio" ];
      # NOT sbc-deploy's `realtime = true`: that runs the WHOLE process at
      # SCHED_FIFO 50 (the WSS server and render pool included, level with the
      # IRQ threads). The player raises only its output thread (SCHED_FIFO
      # ${toString playerRtPrio}) and needs just these two capabilities for it:
      # CAP_SYS_NICE (FIFO + CPU affinity) and CAP_IPC_LOCK (mlockall). The
      # apa102 path (the Python driver) keeps the whole-process FIFO.
      realtime = ledOutput != "fpga";
      extraCapabilities = pkgs.lib.optionals (ledOutput == "fpga") [ "CAP_SYS_NICE" "CAP_IPC_LOCK" ];
      # The Rust player serves WSS on this port (the phone + HITL harness reach it
      # over the net, via res.forward on the rig); opens the firewall.
      ports = pkgs.lib.optionals (ledOutput == "fpga") [ playerRsWssPort ];
      runtimeDirectory = "ledmapper";
      readWritePaths = [ "/run/ledmapper" ];
      # On the FPGA path, also wait for /dev/spidev0.0 (a device unit via the
      # TAG+="systemd" rule in fpga.nix): a cold boot started the player before
      # the node existed. Wants= keeps it soft (the player retries spidev itself).
      after = [ "local-fs.target" ] ++ pkgs.lib.optionals (ledOutput == "fpga") [ "dev-spidev0.0.device" ];
      wants = pkgs.lib.optionals (ledOutput == "fpga") [ "dev-spidev0.0.device" ];
      # Commission the FPGA (flash the Tang Nano over USB) BEFORE streaming SPI,
      # only when driving the FPGA. `+` runs it as root (bypasses the
      # User=ledmapper sandbox) so it can claim the USB device; the player's own
      # ExecStart then opens /dev/spidev. Gating keeps the apa102 path (and its
      # bare eval) from needing SBC_FPGA_BITSTREAM.
      extraServiceConfig = pkgs.lib.optionalAttrs (ledOutput == "fpga") {
        ExecStartPre = [ "+${fpgaCommission}" "+${spiPumpRt}" ];
        # Headroom for the commission's 20 s FT2232 wait + a full reflash.
        TimeoutStartSec = 180;
        # The player only mlockall()s when it can't hit this limit later.
        LimitMEMLOCK = "infinity";
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
