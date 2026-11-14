# QEMU test of the full-system OTA (nix/system-update.nix, splanc_image/sysupdate.py).
#
#   nix build ./pi/bridge/image#checks.aarch64-linux.vm-ota -L
#   # no KVM / no `kvm` system feature: run the driver directly (TCG, slow):
#   nix build ./pi/bridge/image#checks.aarch64-linux.vm-ota.driver -o driver && ./driver/bin/nixos-test-driver
#
# Three systems built from the same appliance modules (bridgeModules):
#   machine (A)  what the bridge runs
#   b      (B)   A + a new service (splanc-ota-dummy, also a health unit)
#   bbad         A + a health unit that never comes up
# CI's release path is reproduced in a derivation: nixpkgs' mkBinaryCache of B
# and bbad, `nix store sign` with a key generated in the build, then
# splanc_image.sysrelease -> manifest + flat NARs + channel pointers. The NARs
# of paths A already has are dropped (the device must not need them) and the
# site is a .tar (no plaintext store paths: A must NOT already have B's paths
# registered). A serves it on 127.0.0.1:8001.
#
# QEMU boots the test VM's kernel directly (no bootloader); after the first
# boot the kernel command line gets init=/nix/var/nix/profiles/system/init, so
# every later boot starts whatever the system profile points at -- what
# `switch-to-configuration boot` + reboot does on the Pi (the bootloader writes
# themselves -- Pi 5 tryboot.txt, U-Boot extlinux -- aren't exercised here).
#
# Checks:
#   1. the background check only discovers: B is "available" (sized from the
#      manifest), not one store path fetched, nothing applied -- also not on
#      later timer runs with no app connected;
#   2. a release signed by the wrong key, and an unsigned one, are rejected:
#      nothing imported, profile untouched;
#   3. with an app connected, the CLI's `check` only stages (delta: fewer store
#      paths fetched than the closure has), and the timer never applies it;
#   4. bbad: installed when the screen confirms (a request file dropped as the
#      display's user), rebooted into, fails its health check, rolled back to A
#      (rebooted), remembered as bad (not retried);
#   5. the screen's "Check for updates" (request `check`) finds B; the screen's
#      confirmation installs it: rebooted into, the new service runs, the health
#      check commits it; /var/lib state, Wi-Fi profiles and the bridge identity
#      survive; two generations kept, bbad no longer rooted (collectable).
{ pkgs, bridgeModules }:
let
  lib = pkgs.lib;
  version = "9.9.1";
  port = 8001;

  keys = pkgs.runCommand "ota-test-keys" { nativeBuildInputs = [ pkgs.nix ]; } ''
    export HOME=$TMPDIR NIX_STATE_DIR=$TMPDIR/state NIX_CONF_DIR=$TMPDIR/etc
    mkdir -p $out
    for k in good evil; do
      nix --extra-experimental-features nix-command key generate-secret --key-name splanc-ota-$k-1 >$out/$k.sk
      nix --extra-experimental-features nix-command key convert-secret-to-public <$out/$k.sk >$out/$k.pub
    done
  '';

  common = { config, lib, name, ... }: {
    imports = bridgeModules;
    # (the image's default "splanc-bridge" vs the test driver's node names)
    networking.hostName = lib.mkForce name;
    splancBridge.board = "vm";
    networking.networkmanager.enable = true;
    virtualisation.memorySize = 1536;
    # Test nodes can't switch by default; the bridge image can.
    system.switch.enable = true;
    systemd.services.splanc-display.environment.SPLANC_DISPLAY_HDMI = "png:/run/splanc-display/hdmi.png";
    systemd.timers.splanc-agent-auto-check.enable = lib.mkForce false;
    systemd.timers.splanc-system-update.enable = lib.mkForce false; # the script drives it
    splancBridge.systemUpdate = {
      channelUrl = "http://127.0.0.1:${toString port}/good.json";
      allowHttp = true;
      healthStable = 10;
      healthTimeout = 120;
    };
    # The test key exists only as a build output: inject it into the updater's
    # config without import-from-derivation.
    environment.etc."splanc-bridge/system-update.json".source = lib.mkForce (
      pkgs.runCommand "system-update.json" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq --arg k "$(cat ${keys}/good.pub)" '.public_keys = [$k]' \
          ${pkgs.writeText "base.json" config.environment.etc."splanc-bridge/system-update.json".text} >$out
      ''
    );
  };

  site = { a, b, bbad }:
    let
      cache = pkgs.mkBinaryCache { rootPaths = [ b bbad ]; };
      have = pkgs.closureInfo { rootPaths = [ a ]; };
      py = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.fileFilter (f: f.hasExt "py") ../splanc_image;
      };
    in
    pkgs.runCommand "ota-test-site" { nativeBuildInputs = [ pkgs.nix pkgs.python3 ]; } ''
      export HOME=$TMPDIR NIX_STATE_DIR=$TMPDIR/state NIX_CONF_DIR=$TMPDIR/etc
      export PYTHONPATH=${py}
      nixc() { nix --extra-experimental-features nix-command "$@"; }
      mkdir site
      variant() { # name toplevel signing-key|"" require-key|""
        local name=$1 top=$2 sk=$3 req=$4
        mkdir -p c-$name
        cp ${cache}/*.narinfo ${cache}/nix-cache-info c-$name/
        ln -s ${cache}/nar c-$name/nar
        chmod -R u+w c-$name
        if [ -n "$sk" ]; then nixc store sign --store "file://$PWD/c-$name" --key-file "$sk" --recursive "$top"; fi
        python3 -m splanc_image.sysrelease manifest --cache c-$name --toplevel "$top" --board vm \
          --version ${version} --nar-base-url http://127.0.0.1:${toString port}/$name \
          ''${req:+--require-key $req} --out site/$name
        python3 -m splanc_image.sysrelease pointer --manifest site/$name/bridge-system-vm-${version}.json \
          --manifest-url http://127.0.0.1:${toString port}/$name/bridge-system-vm-${version}.json --out site/$name.json \
          --allow-http
      }
      variant good ${b} ${keys}/good.sk splanc-ota-good-1
      variant bad ${bbad} ${keys}/good.sk splanc-ota-good-1
      variant evil ${b} ${keys}/evil.sk splanc-ota-evil-1
      variant unsigned ${b} "" ""
      # sysrelease refuses a release whose paths aren't all signed by the key.
      if python3 -m splanc_image.sysrelease manifest --cache c-unsigned --toplevel ${b} --board vm \
           --version ${version} --nar-base-url http://x --require-key splanc-ota-good-1 --out $TMPDIR/x 2>/dev/null; then
        echo "sysrelease accepted an unsigned release" >&2; exit 1
      fi
      # Drop the NARs of every path A already has: an update must only fetch the delta.
      python3 - ${have}/store-paths site <<'EOF'
      import json, os, sys
      have = set(open(sys.argv[1]).read().split())
      root = sys.argv[2]
      for d in os.listdir(root):
          p = os.path.join(root, d)
          if not os.path.isdir(p):
              continue
          man = json.load(open(os.path.join(p, f"bridge-system-vm-${version}.json")))
          for text in man["narinfo"].values():
              f = dict(l.split(": ", 1) for l in text.splitlines() if ": " in l)
              if f["StorePath"] in have:
                  try:
                      os.unlink(os.path.join(p, f["URL"][len("nar/"):]))
                  except FileNotFoundError:
                      pass
      EOF
      mkdir -p $out
      tar -C site -cf $out/site.tar .
      du -sh site/* >$out/sizes.txt
    '';
in
pkgs.testers.runNixOSTest ({ nodes, ... }:
let
  a = nodes.machine.system.build.toplevel;
  b = nodes.b.system.build.toplevel;
  bbad = nodes.bbad.system.build.toplevel;
  otaSite = site { inherit a b bbad; };
in
{
  name = "splanc-bridge-ota";
  node.pkgsReadOnly = false;

  nodes.machine = common;
  nodes.b = {
    imports = [ common ];
    systemd.services.splanc-ota-dummy = {
      description = "Service added by system B";
      wantedBy = [ "multi-user.target" ];
      script = "echo B > /run/splanc-ota-dummy; exec sleep infinity";
    };
    splancBridge.systemUpdate.healthUnits = [ "splanc-ota-dummy.service" ];
  };
  nodes.bbad = {
    imports = [ common ];
    systemd.services.splanc-ota-canary = {
      description = "A health unit that never comes up";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = { ExecStart = "${pkgs.coreutils}/bin/false"; Restart = "always"; RestartSec = 2; };
      unitConfig.StartLimitIntervalSec = 0;
    };
    splancBridge.systemUpdate.healthUnits = [ "splanc-ota-canary.service" ];
  };

  testScript = ''
    import json
    import os

    A, B, BBAD = "${a}", "${b}", "${bbad}"

    def state():
        return json.loads(machine.succeed("cat /var/lib/splanc-system-update/state.json"))

    def booted():
        return machine.succeed("readlink -f /run/booted-system").strip()

    def serve():
        machine.succeed(
            "systemd-run --unit stub-ota-site --collect "
            "${pkgs.python3}/bin/python3 -m http.server -b 127.0.0.1 -d /var/lib/ota-site ${toString port}"
        )
        machine.wait_for_open_port(${toString port})

    def wait_reboot(settle=True):
        machine.connected = False
        machine.connect()
        if settle:
            machine.wait_for_unit("multi-user.target")

    # First boot (QEMU's direct kernel boot of A): make the system profile
    # point at A, as on a flashed SD card; then boot from the profile.
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.succeed(f"nix-env -p /nix/var/nix/profiles/system --set {A}")
    machine.succeed("mkdir -p /var/lib/splanc-bridge && echo keep-me > /var/lib/splanc-bridge/ota-test-marker")
    machine.succeed(
        "mkdir -p /etc/NetworkManager/system-connections && printf '[connection]\\nid=keep\\ntype=wifi\\n[wifi]\\nssid=Keep\\n' "
        "> /etc/NetworkManager/system-connections/keep.nmconnection && "
        "chmod 600 /etc/NetworkManager/system-connections/keep.nmconnection"
    )
    machine.shutdown()
    os.environ["QEMU_KERNEL_PARAMS"] = "init=/nix/var/nix/profiles/system/init"
    machine.start(allow_reboot=True)
    machine.wait_for_unit("multi-user.target")
    assert booted() == A, booted()
    machine.copy_from_host("${otaSite}/site.tar", "/var/lib/ota-site.tar")
    machine.succeed("mkdir -p /var/lib/ota-site && tar -C /var/lib/ota-site -xf /var/lib/ota-site.tar")
    print(machine.succeed("cat ${otaSite}/sizes.txt || true"))
    serve()
    machine.fail(f"nix-store --check-validity {B}")

    SITE = "/var/lib/ota-site"
    CHANNEL = "http://127.0.0.1:${toString port}"

    def sys_status():
        return json.loads(machine.succeed("cat /run/splanc-system-update/status.json"))

    def timer_runs(n=3):
        """The background check, as its timer would start it (n times)."""
        for _ in range(n):
            machine.succeed("systemctl start splanc-system-update.service")

    def request(name):
        """What the screen does on a confirmed action: drop a request file, as
        the display's user. Root's path unit starts the matching unit."""
        machine.succeed(f"runuser -u splanc -- touch /run/splanc-update-request/{name}")

    def not_applied():
        assert booted() == A, booted()
        assert machine.succeed("readlink -f /nix/var/nix/profiles/system").strip() == A
        assert state()["pending"] is None, state()

    with subtest("the background check only discovers; nothing installs without a confirmation"):
        machine.succeed("systemctl is-active splanc-update-request.path")
        # Only the display's sandbox may write requests: the bridge runs as the same
        # user but sees the directory read-only. (A name that isn't a request is
        # deleted and ignored.)
        machine.wait_for_unit("splanc-bridge.service")
        machine.wait_for_unit("splanc-display.service")
        def as_unit(unit, cmd):
            return (
                # -r/-w: the target's root + cwd, i.e. its sandbox's mounts
                f"nsenter -t $(systemctl show -p MainPID --value {unit}) -m -r -w "
                f"-S $(id -u splanc) -G $(id -g splanc) -- {cmd}"
            )
        machine.fail(as_unit("splanc-bridge", "${pkgs.coreutils}/bin/touch /run/splanc-update-request/probe"))
        machine.succeed(as_unit("splanc-display", "${pkgs.coreutils}/bin/touch /run/splanc-update-request/probe"))
        machine.wait_until_succeeds("test -z \"$(ls -A /run/splanc-update-request)\"", timeout=30)
        machine.wait_until_succeeds(
            "journalctl -u splanc-update-request -o cat | grep -q 'ignoring unknown request'", timeout=30
        )
        machine.fail("journalctl -u splanc-update-request -o cat | grep -q 'splanc-update-request: starting'")
        timer_runs(1)
        st = state()
        assert st["available"]["toplevel"] == B and st["staged"] is None, st
        assert 0 < st["available"]["paths"] < st["available"]["total_paths"], st
        s = sys_status()
        assert s["state"] == "available" and s["available"]["version"] == "${version}", s
        assert s["available"]["download_bytes"] > 0 and s["auto_check"] is True, s
        machine.fail(f"nix-store --check-validity {B}")
        # Later runs (no app connected, nothing in the way): still not installed.
        timer_runs(3)
        machine.sleep(5)
        not_applied()
        machine.fail(f"nix-store --check-validity {B}")
        # The screens find it again after a reboot (before the first timer run).
        machine.succeed("rm /run/splanc-system-update/status.json")
        machine.succeed("systemctl restart splanc-system-update-status.service")
        assert sys_status()["state"] == "available"

    with subtest("wrong key and unsigned releases are rejected"):
        for name in ("evil", "unsigned"):
            machine.fail(f"splanc-system-update check --channel {CHANNEL}/{name}.json")
            st = state()
            assert st["last_result"]["result"] == "failed", st
            assert "not signed by a trusted key" in st["last_result"]["message"], st
            assert st["staged"] is None and st["pending"] is None, st
            machine.fail(f"nix-store --check-validity {B}")
            assert machine.succeed("readlink -f /nix/var/nix/profiles/system").strip() == A

    with subtest("with an app connected, `check` only stages; the timer never applies it"):
        machine.succeed("systemctl stop splanc-bridge.service")
        machine.succeed("mkdir -p /run/splanc-bridge && echo '{\"v\": 1, \"state\": \"paired\", \"clients\": 1}' > /run/splanc-bridge/status.json")
        machine.succeed(f"splanc-system-update check --channel {CHANNEL}/bad.json")
        st = state()
        assert st["staged"]["toplevel"] == BBAD and st["pending"] is None, st
        assert 0 < st["staged"]["fetched_paths"] < st["staged"]["total_paths"], st["staged"]
        machine.succeed(f"nix-store --check-validity {BBAD}")
        assert sys_status()["state"] == "staged"
        assert booted() == A
        machine.succeed("rm -f /run/splanc-bridge/status.json && systemctl start splanc-bridge.service")
        machine.sleep(15)
        # The app is gone; the old updater would have installed it now. Not any more.
        timer_runs(3)
        machine.sleep(5)
        not_applied()
        assert state()["staged"]["toplevel"] == BBAD

    with subtest("confirmed on the screen: a system that fails its health check is rolled back"):
        # The channel now names bbad (as when a release is re-pointed).
        machine.succeed(f"cp {SITE}/good.json {SITE}/good.json.orig && cp {SITE}/bad.json {SITE}/good.json")
        request("install-system")
        wait_reboot(settle=False)  # -> bbad
        # bbad's confirm gives up after healthTimeout and reboots into A.
        wait_reboot()
        assert booted() == A, booted()
        st = state()
        assert st["last_result"]["result"] == "rolled_back", st
        assert "splanc-ota-canary" in st["last_result"]["message"], st
        assert BBAD in st["bad"] and st["pending"] is None, st
        assert machine.succeed("readlink -f /nix/var/nix/profiles/system").strip() == A
        machine.succeed(f"mv {SITE}/good.json.orig {SITE}/good.json")
        serve()
        machine.succeed(f"splanc-system-update scan --channel {CHANNEL}/bad.json")
        assert "failed on this bridge before" in machine.succeed("cat /run/splanc-system-update/status.json")
        assert sys_status()["last_result"]["result"] == "rolled_back"

    with subtest("check from the screen -> available -> confirm -> install -> health check commits"):
        # The bridge's identity (the real agent writes it) must survive unchanged.
        machine.wait_until_succeeds("test -s /var/lib/splanc-bridge/bridge.json", timeout=120)
        identity = machine.succeed("sha256sum /var/lib/splanc-bridge/bridge.json")
        request("check")
        machine.wait_until_succeeds(
            "grep -q '\"state\": \"available\"' /run/splanc-system-update/status.json", timeout=120
        )
        assert sys_status()["available"]["version"] == "${version}"
        machine.fail(f"nix-store --check-validity {B}")
        not_applied()
        request("install-system")
        wait_reboot()
        assert booted() == B, booted()
        machine.wait_for_unit("splanc-ota-dummy.service")
        machine.succeed("grep -qx B /run/splanc-ota-dummy")
        machine.wait_until_succeeds(
            "grep -q '\"result\": \"committed\"' /var/lib/splanc-system-update/state.json", timeout=300
        )
        # (the screens hear "idle" as soon as the commit is saved, before its GC)
        machine.wait_until_succeeds(
            "grep -q '\"state\": \"idle\"' /run/splanc-system-update/status.json", timeout=120
        )
        st = state()
        assert st["pending"] is None and st["staged"] is None and st["available"] is None, st
        assert 0 < st["last_result"]["fetched_paths"] < st["last_result"]["total_paths"], st
        s = sys_status()
        assert s["state"] == "idle" and s["current_version"] == "${version}", s
        assert machine.succeed("sha256sum /var/lib/splanc-bridge/bridge.json") == identity
        machine.succeed("grep -qx keep-me /var/lib/splanc-bridge/ota-test-marker")
        machine.succeed("test -f /etc/NetworkManager/system-connections/keep.nmconnection")
        gens = machine.succeed("ls /nix/var/nix/profiles | grep -c '^system-[0-9]*-link$'").strip()
        assert gens == "2", gens
        assert machine.succeed("readlink -f /nix/var/nix/profiles/system").strip() == B
        # bbad is no longer rooted anywhere (dropped generation + staging root),
        # so the commit's GC can collect it; A (the previous generation) stays.
        print("gc:", st["last_result"].get("gc_error", "ok"))
        roots = machine.succeed(f"nix-store -q --roots {BBAD} || true").strip()
        assert roots == "", roots
        machine.succeed(f"nix-store --check-validity {A}")
        assert machine.succeed(f"nix-store -q --roots {A}").strip() != ""
        # The next boot is B as well.
        machine.reboot()
        wait_reboot()
        assert booted() == B, booted()
        machine.succeed("systemctl is-active splanc-ota-dummy.service")
  '';
})
