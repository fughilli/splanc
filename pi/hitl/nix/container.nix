# The HITL test container image (nix dockerTools). sshd + an ESP32 toolbox.
#
# The manager runs this per reservation with the ESP32 attached and the holder's
# key mounted at /run/hitl/authorized_keys; the entrypoint installs the key and
# starts sshd. Toolbox is MVP (flash + serial); BLE/JTAG tools are added as they
# get exercised (just more packages in `toolbox`).
{ pkgs }:
let
  # esptool pulls python-ecdsa, which nixpkgs currently flags insecure. Permit it
  # just for this image by re-importing nixpkgs with the allowance, so the caller
  # needn't set it globally.
  p = import pkgs.path {
    inherit (pkgs.stdenv.hostPlatform) system;
    config = (pkgs.config or { }) // {
      permittedInsecurePackages = [ "python3.12-ecdsa-0.19.1" ];
    };
  };

  sshUser = "agent";

  # nixpkgs esptool ships esptool.py/espefuse.py/espsecure.py; add no-suffix
  # aliases so `esptool` etc. (what agents reflexively type) also work.
  espAliases = p.runCommand "esp-aliases" { } ''
    mkdir -p $out/bin
    ln -s ${p.esptool}/bin/esptool.py   $out/bin/esptool
    ln -s ${p.esptool}/bin/espefuse.py  $out/bin/espefuse
    ln -s ${p.esptool}/bin/espsecure.py $out/bin/espsecure
  '';

  # Python with pyserial + bleak actually importable (listing them separately does
  # NOT put them on sys.path). bleak = BLE central via the host bluetoothd/D-Bus.
  pyEnv = p.python3.withPackages (ps: with ps; [ pyserial bleak ]);

  # Espressif OpenOCD — the C6's (RISC-V) built-in USB-JTAG (mainline openocd only
  # covers Xtensa esp32/s2/s3). Needs raw USB (the daemon passes /dev/bus/usb).
  openocdEsp = import ./openocd-esp32.nix { pkgs = p; };

  # hitl-jtag: openocd against the C6 built-in USB-JTAG. No args → halt + read pc +
  # reset-run; otherwise pass through openocd -c commands (e.g. a gdbserver).
  hitlJtag = p.writeShellApplication {
    name = "hitl-jtag";
    text = ''
      cfg=(-s ${openocdEsp}/share/openocd/scripts -f board/esp32c6-builtin.cfg)
      # Multi-DUT: with several identical C6 USB-JTAGs on the same bus, select this
      # DUT's adapter by serial (the daemon sets HITL_ADAPTER_SERIAL per DUT). Set
      # before init so the adapter driver binds the right device. Unset (single-DUT)
      # → openocd auto-picks the sole board, unchanged.
      if [ -n "''${HITL_ADAPTER_SERIAL:-}" ]; then
        cfg+=(-c "adapter serial ''${HITL_ADAPTER_SERIAL}")
      fi
      if [ "$#" -eq 0 ]; then
        exec ${openocdEsp}/bin/openocd "''${cfg[@]}" -c "init; halt; reg pc; reset run; shutdown"
      fi
      exec ${openocdEsp}/bin/openocd "''${cfg[@]}" "$@"
    '';
  };

  # riscv32 GDB client for the C6 (nixpkgs has none; host gdb can't debug it).
  riscvGdb = import ./riscv-gdb.nix { pkgs = p; };

  # hitl-gdb [elf] [extra gdb args]: start the openocd gdbserver in the background
  # and attach gdb to it. No extra args → interactive; pass -batch -ex … to script.
  hitlGdb = p.writeShellApplication {
    name = "hitl-gdb";
    text = ''
      elf=""
      if [ "$#" -gt 0 ] && [ -f "$1" ]; then elf="$1"; shift; fi
      log=/tmp/hitl-openocd.log
      sel=()
      # Multi-DUT: target this DUT's USB-JTAG by serial when the daemon set it.
      if [ -n "''${HITL_ADAPTER_SERIAL:-}" ]; then
        sel=(-c "adapter serial ''${HITL_ADAPTER_SERIAL}")
      fi
      ${openocdEsp}/bin/openocd -s ${openocdEsp}/share/openocd/scripts \
        -f board/esp32c6-builtin.cfg "''${sel[@]}" > "$log" 2>&1 &
      ocd=$!
      trap 'kill "$ocd" 2>/dev/null || true' EXIT
      for _ in $(seq 1 40); do
        grep -q "Listening on port 3333" "$log" 2>/dev/null && break
        sleep 0.25
      done
      args=(-ex "target remote :3333")
      if [ -n "$elf" ]; then args=("$elf" "''${args[@]}"); fi
      exec ${riscvGdb}/bin/riscv32-esp-elf-gdb "''${args[@]}" "$@"
    '';
  };

  # hitl-flash: flash a bundle (flash.json + bins) with esptool, offsets from the
  # manifest, v4/v5 syntax auto-picked. --monitor reads the serial console after.
  hitlFlash = p.writeTextFile {
    name = "hitl-flash";
    executable = true;
    destination = "/bin/hitl-flash";
    text = ''
      #!${pyEnv}/bin/python3
      import argparse, json, os, re, subprocess, sys, tarfile, tempfile
      def syntax():
          v = subprocess.run(["esptool", "version"], capture_output=True, text=True)
          m = re.search(r"v?(\d+)\.", (v.stdout or "") + (v.stderr or ""))
          major = int(m.group(1)) if m else 4
          return ("write-flash", "--flash-mode", "--flash-freq", "--flash-size") if major >= 5 \
              else ("write_flash", "--flash_mode", "--flash_freq", "--flash_size")
      ap = argparse.ArgumentParser()
      ap.add_argument("bundle"); ap.add_argument("--port", default="/dev/ttyACM0")
      ap.add_argument("--baud", default="460800")
      ap.add_argument("--monitor", action="store_true", help="read serial after flashing")
      ap.add_argument("--monitor-seconds", type=float, default=10.0)
      # HITL clean-slate: full chip erase before writing, so the DUT comes up with
      # an empty NVS (no stored WiFi creds -> it does NOT auto-join, it waits in
      # soft-AP for provisioning) and an empty littlefs (no stale maps). This is a
      # RIG-ONLY knob: live-device firmware updates use a different path and keep
      # their stored maps + WiFi config. write_flash still repopulates the 4 images.
      ap.add_argument("--erase-fs", action="store_true",
                      help="full chip erase first (wipe NVS creds + littlefs) — HITL clean slate")
      a = ap.parse_args()
      d = tempfile.mkdtemp(prefix="hitl-flash-")
      with tarfile.open(a.bundle) as t: t.extractall(d)
      m = json.load(open(os.path.join(d, "flash.json")))
      wf, fm, ff, fs = syntax()
      # Flash and hard-reset into the app; the monitor then reads the boot logs
      # that follow (reopen-on-disconnect survives the native-USB re-enumeration).
      cmd = ["esptool", "--chip", m["chip"], "--port", a.port, "--baud", a.baud,
             "--after", "hard_reset", wf, fm, m.get("flash_mode", "keep"),
             ff, m.get("flash_freq", "keep"), fs, m.get("flash_size", "keep")]
      if a.erase_fs:
          cmd.append("--erase-all")  # erase whole chip before programming
      for img in m["images"]:
          cmd += [img["offset"], os.path.join(d, img["file"])]
      sys.stderr.write("+ " + " ".join(cmd) + "\n")
      rc = subprocess.call(cmd)
      if rc or not a.monitor:
          sys.exit(rc)
      # No monitor-side reset: the flash already reset into the app.
      os.execv("${hitlMonitor}/bin/hitl-monitor",
               ["hitl-monitor", "--port", a.port,
                "--seconds", str(a.monitor_seconds)])
    '';
  };

  # hitl-monitor: robust serial reader for the ESP32-C6's native USB-Serial-JTAG.
  # Reopens on disconnect (a chip reset re-enumerates the device), so it catches
  # the boot logs that follow a reset. --reset issues esptool's native-USB reset.
  hitlMonitor = p.writeTextFile {
    name = "hitl-monitor";
    executable = true;
    destination = "/bin/hitl-monitor";
    text = ''
      #!${pyEnv}/bin/python3
      import argparse, subprocess, sys, time
      import serial
      ap = argparse.ArgumentParser()
      ap.add_argument("--port", default="/dev/ttyACM0")
      ap.add_argument("--baud", type=int, default=115200)
      ap.add_argument("--seconds", type=float, default=0.0, help="0 = until interrupted")
      ap.add_argument("--reset", action="store_true", help="esptool hard-reset first (catch boot logs)")
      a = ap.parse_args()
      if a.reset:
          # esptool knows the native USB-Serial-JTAG reset sequence; a bare RTS
          # pulse does NOT reset a native-USB C6.
          subprocess.run(["esptool", "--port", a.port, "--before", "default_reset",
                          "--after", "hard_reset", "run"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
      deadline = time.time() + a.seconds if a.seconds > 0 else None
      ser = None
      try:
          while deadline is None or time.time() < deadline:
              if ser is None:
                  try:
                      ser = serial.Serial(a.port, a.baud, timeout=0.2)
                      ser.dtr = False; ser.rts = False
                  except Exception:
                      time.sleep(0.1); continue
              try:
                  chunk = ser.read(4096)
                  if chunk:
                      sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
              except Exception:
                  try: ser.close()
                  except Exception: pass
                  ser = None; time.sleep(0.1)
      except KeyboardInterrupt:
          pass
      finally:
          if ser is not None:
              ser.close()
    '';
  };

  # hitl-ble: BLE central helper (bleak → host bluetoothd over the mounted system
  # D-Bus socket). Scan for the DUT and dump/read its GATT.
  hitlBle = p.writeTextFile {
    name = "hitl-ble";
    executable = true;
    destination = "/bin/hitl-ble";
    text = ''
      #!${pyEnv}/bin/python3
      import argparse, asyncio, os, sys
      # The container has no /var/run/dbus; point dbus-fast at the mounted socket.
      os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")
      from bleak import BleakScanner, BleakClient
      # Route BLE at the adapter the daemon selected (a USB dongle on rigs whose
      # onboard controller is flaky); bleak's BlueZ backend defaults to hci0.
      _adp = os.environ.get("HITL_BLE_ADAPTER", "").strip()
      _akw = {"adapter": _adp} if _adp else {}
      async def scan(seconds, name):
          found = await BleakScanner.discover(timeout=seconds, return_adv=True, **_akw)
          for addr, (d, adv) in sorted(found.items()):
              if name and name.lower() not in (d.name or "").lower():
                  continue
              print("%s  rssi=%s  %s" % (addr, adv.rssi, d.name or ""))
      async def gatt(address):
          async with BleakClient(address, **_akw) as c:
              for s in c.services:
                  print("service %s" % s.uuid)
                  for ch in s.characteristics:
                      print("  char %s  [%s]" % (ch.uuid, ",".join(ch.properties)))
      ap = argparse.ArgumentParser(prog="hitl-ble")
      sub = ap.add_subparsers(dest="cmd", required=True)
      s = sub.add_parser("scan"); s.add_argument("--seconds", type=float, default=6.0); s.add_argument("--name", default="")
      g = sub.add_parser("gatt"); g.add_argument("address")
      a = ap.parse_args()
      try:
          asyncio.run(scan(a.seconds, a.name) if a.cmd == "scan" else gatt(a.address))
      except Exception as e:
          sys.exit("hitl-ble: %s" % e)
    '';
  };

  # hitl-capture: thin client for the rig's SHARED logic analyzer. The FX2 stays
  # on the host (owned by the daemon); this just POSTs to the daemon's /capture
  # over the podman host gateway ($HITL_CAPTURE_SERVER), naming this reservation's
  # DUT ($HITL_DUT), and prints the decoded pixels. No sigrok or raw USB in the
  # container. Stdlib only.
  hitlCapture = p.writeTextFile {
    name = "hitl-capture";
    executable = true;
    destination = "/bin/hitl-capture";
    text = ''
      #!${pyEnv}/bin/python3
      import argparse, base64, json, os, sys, urllib.request, urllib.error
      ap = argparse.ArgumentParser(prog="hitl-capture",
          description="capture + decode this DUT's LED line via the rig's shared logic analyzer")
      ap.add_argument("--dut", default=os.environ.get("HITL_DUT", ""),
                      help="DUT name to capture (default $HITL_DUT)")
      ap.add_argument("--server", default=os.environ.get("HITL_CAPTURE_SERVER", ""),
                      help="daemon base URL (default $HITL_CAPTURE_SERVER)")
      ap.add_argument("--protocol", default="", help="override decoder: ws2812|spi")
      ap.add_argument("--samples", type=int, default=0, help="capture length (0 = rig default)")
      ap.add_argument("--sr", default="", help="also write the raw .sr session to this file")
      ap.add_argument("--json", action="store_true", help="print the raw JSON result")
      a = ap.parse_args()
      if not a.server:
          sys.exit("hitl-capture: no daemon URL ($HITL_CAPTURE_SERVER unset; pass --server)")
      req = {"device": a.dut, "protocol": a.protocol, "samples": a.samples, "save_sr": bool(a.sr)}
      body = json.dumps(req).encode()
      try:
          with urllib.request.urlopen(
                  urllib.request.Request(a.server.rstrip("/") + "/capture", data=body,
                                         headers={"Content-Type": "application/json"}),
                  timeout=60) as r:
              res = json.loads(r.read())
      except urllib.error.HTTPError as e:
          sys.exit("hitl-capture: %s: %s" % (e.code, e.read().decode(errors="replace")))
      except Exception as e:
          sys.exit("hitl-capture: %s" % e)
      if a.sr and res.get("sr"):
          with open(a.sr, "wb") as f:
              f.write(base64.b64decode(res["sr"]))
          sys.stderr.write("hitl-capture: wrote raw session to %s\n" % a.sr)
      if a.json:
          json.dump(res, sys.stdout); print()
      else:
          for i, px in enumerate(res.get("pixels") or []):
              print("%3d: #%02x%02x%02x" % (i, px["r"], px["g"], px["b"]))
    '';
  };

  toolbox = with p; [
    bashInteractive
    coreutils
    openssh
    # ESP flashing + serial (MVP):
    esptool
    espAliases
    picocom
    pyEnv
    hitlFlash
    hitlMonitor
    # Shared logic analyzer capture (thin client to the daemon's /capture):
    hitlCapture
    # BLE central (drives the host bluetoothd over the mounted system D-Bus).
    # ImprovBLE provisioning isn't a baked tool: the e2e harness ships its own
    # provisioner (pi/hitl/harness/hitl_improv.py) and runs it with this python3.
    hitlBle
    # bluez also brings `btmon`: the daemon captures BLE HCI host-side and mounts
    # the btsnoop read-only at /run/hitl/capture/hci.btsnoop, so `btmon -r` reads
    # a live/finished capture in-container (`hitl btmon fetch` pulls it out).
    bluez
    # JTAG/debug over the C6 built-in USB-JTAG (needs the daemon's /dev/bus/usb):
    openocdEsp
    hitlJtag
    riscvGdb
    hitlGdb
    # --- next layers (add as exercised) ---
    # linuxPackages.usbip           # attach the dev board inside the container
    # openocd gdb                   # JTAG debug port
    # bluez python3Packages.bleak   # BLE scan/connect/commands
  ];
  toolPath = p.lib.makeBinPath toolbox;

  sshdConfig = p.writeText "sshd_config" ''
    Port 22
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    UsePAM no
    AuthorizedKeysFile /home/${sshUser}/.ssh/authorized_keys
    Subsystem sftp ${p.openssh}/libexec/sftp-server
    PidFile /run/sshd.pid
    SetEnv PATH=${toolPath}:/bin:/usr/bin DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
    # The daemon injects per-reservation HITL_* env (HITL_DUT, HITL_CAPTURE_SERVER,
    # HITL_ADAPTER_SERIAL) via `podman -e`; that reaches sshd's process but not the
    # session it spawns. Read them from ~/.ssh/environment (written by the entrypoint)
    # so both interactive shells and `ssh host cmd` (the harness capture path) see them.
    PermitUserEnvironment yes
  '';

  entrypoint = p.writeShellApplication {
    name = "hitl-entrypoint";
    runtimeInputs = [ p.openssh p.coreutils p.gnugrep ];
    text = ''
      user="''${HITL_SSH_USER:-${sshUser}}"
      mkdir -p /run /etc/ssh
      ssh-keygen -A                 # host keys under /etc/ssh
      # Fix home ownership at runtime (root here); build-time chown isn't allowed.
      chown -R "$user":"$user" "/home/$user" 2>/dev/null || true
      install -d -m700 -o "$user" -g "$user" "/home/$user/.ssh"
      if [ -f /run/hitl/authorized_keys ]; then
        install -m600 -o "$user" -g "$user" /run/hitl/authorized_keys "/home/$user/.ssh/authorized_keys"
        echo "hitl: installed $(wc -l < "/home/$user/.ssh/authorized_keys") authorized key(s) for $user" >&2
      else
        echo "hitl: WARN no /run/hitl/authorized_keys mounted" >&2
      fi
      # Diagnostics for pubkey-auth issues (StrictModes checks these):
      ls -lad "/home/$user" "/home/$user/.ssh" "/home/$user/.ssh/authorized_keys" >&2 2>/dev/null || true
      # Expose the per-reservation HITL_* env (set on this process by `podman -e`) to
      # SSH sessions. sshd doesn't pass its own env to sessions; PermitUserEnvironment
      # + ~/.ssh/environment does, for both interactive shells and `ssh host cmd`
      # (e.g. the harness running hitl-capture, which defaults to $HITL_CAPTURE_SERVER).
      printenv | grep -E '^HITL_[A-Za-z0-9_]+=' > "/home/$user/.ssh/environment" || true
      chown "$user":"$user" "/home/$user/.ssh/environment" 2>/dev/null || true
      chmod 600 "/home/$user/.ssh/environment" 2>/dev/null || true
      # Make passed-through serial/JTAG nodes usable by the (non-root) agent —
      # they arrive with the host's root:dialout 660 perms. The container is
      # ephemeral + single-user, so opening them up is fine.
      for dev in /dev/ttyACM* /dev/ttyUSB*; do
        if [ -e "$dev" ]; then chmod a+rw "$dev" 2>/dev/null || true; fi
      done
      exec ${p.openssh}/bin/sshd -D -e -f ${sshdConfig}
    '';
  };
in
p.dockerTools.buildLayeredImage {
  name = "hitl-test";
  tag = "latest";
  contents = toolbox;
  # Minimal rootfs: the agent + sshd-privsep users, /tmp, a login profile that
  # puts the toolbox on PATH for interactive SSH shells.
  extraCommands = ''
    mkdir -p tmp var/empty home/${sshUser} run etc/profile.d
    chmod 1777 tmp
    cat > etc/passwd <<EOF
    root:x:0:0:root:/root:${p.bashInteractive}/bin/bash
    ${sshUser}:x:1000:1000:agent:/home/${sshUser}:${p.bashInteractive}/bin/bash
    sshd:x:74:74:sshd privsep:/var/empty:${p.shadow}/bin/nologin
    EOF
    cat > etc/group <<EOF
    root:x:0:
    ${sshUser}:x:1000:
    sshd:x:74:
    EOF
    printf 'export PATH=%s:/bin:/usr/bin\n' "${toolPath}" > etc/profile
    cp etc/profile etc/bashrc
  '';
  config = {
    Cmd = [ "${entrypoint}/bin/hitl-entrypoint" ];
    ExposedPorts = { "22/tcp" = { }; };
    Env = [
      "PATH=${toolPath}:/bin:/usr/bin"
      # bleak/dbus-fast default to /var/run/dbus/... which the container lacks;
      # point them at the mounted host socket so BLE reaches the host bluetoothd.
      "DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket"
    ];
  };
}
