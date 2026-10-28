# QEMU smoke test of the bridge appliance (generic aarch64 VM: QEMU can't run
# the Pi firmware, so this boots the SAME appliance modules on a stock kernel;
# the Pi-only bits in nix/rpi.nix are covered by evaluating the real images).
#
#   nix build ./pi/bridge/image#checks.aarch64-linux.vm -L
#
# It checks, in order:
#   1. the baked agent bundle (agent-pin.json) runs `splanc-agent bridge` and
#      writes its status (every baked bundle since #309 has the bridge, so
#      the "no bridge yet" fallback in bridge.nix can't be reached here);
#   2. splanc-flash-config applies a flasher-written boot partition: hostname,
#      WiFi profile moved into NetworkManager (0600 root) and off the FAT
#      partition, settings -> bridge.env (unknown keys dropped), SSH keys ->
#      sshd starts;
#   3. the self-update installs a newer bundle from latest.json (sha256-checked),
#      restarts the bridge onto it with the flash-time relay, and is a no-op the
#      second time; the bridge user can't modify the updated code;
#   4. NetworkManager reads a WiFi profile rendered by the flasher's own code for
#      an SSID/PSK full of keyfile-hostile characters back exactly (nmcli);
#   5. Improv (no BT/WiFi hardware in the VM): a network from the phone app is
#      stored like the flasher's, deduplicated by SSID, read back exactly by
#      NetworkManager; a failed join (real nmcli) rolls the store back;
#   6. the display renders the HDMI page (PNG sink; copied out as hdmi.png) and
#      `splanc-bridge status` shows the pairing code.
{ pkgs, bridgeModules }:
let
  stubVersion = "9.9.9";

  flasherSrc = pkgs.lib.fileset.toSource {
    root = ../../flasher;
    fileset = pkgs.lib.fileset.fileFilter (f: f.hasExt "py") ../../flasher/splanc_flasher;
  };
  trickyWifi = pkgs.runCommand "tricky-wifi" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    mkdir -p $out
    PYTHONPATH=${flasherSrc} python3 ${./tricky_wifi.py} $out
  '';

  # A stand-in agent bundle: `bridge` writes a pairing status and idles.
  stubBundle = pkgs.runCommand "splanc-agent-stub" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    top=splanc-agent-${stubVersion}
    mkdir -p $top/mcp
    cat >$top/bundle.json <<EOF
    {"schema": "splanc-agent-bundle/1", "version": "${stubVersion}"}
    EOF
    cat >$top/mcp/splanc-agent.mjs <<'EOF'
    // VM-test stub of splanc-agent: understands `bridge` (and so 'bridge-ctl').
    import { renameSync, writeFileSync } from "node:fs";
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--relay");
    const now = Date.now() / 1000;
    const doc = {
      v: 1, state: "pairing", relay: at >= 0 ? argv[at + 1] : "", bridge_id: "vm-test",
      pairing: { code: "TEST-CODE", expires_at: now + 3600, url: "https://splanc.io/pair" },
      clients: 0, players: [{ name: "Desk lamp", host: "lamp.local", ok: true }],
      lan_ip: "10.0.2.15", error: null, updated_at: now,
    };
    const p = process.env.SPLANC_BRIDGE_STATUS;
    writeFileSync(p + ".tmp", JSON.stringify(doc));
    renameSync(p + ".tmp", p);
    setInterval(() => {}, 1 << 30);
    EOF
    mkdir -p $out
    tar --sort=name --owner=0 --group=0 --numeric-owner -czf $out/splanc-agent.tgz $top
    sha=$(sha256sum $out/splanc-agent.tgz | cut -d' ' -f1)
    cat >$out/latest.json <<EOF
    {"version": "${stubVersion}", "url": "http://127.0.0.1:8000/splanc-agent.tgz", "sha256": "$sha"}
    EOF
  '';
in
pkgs.testers.runNixOSTest {
  name = "splanc-bridge-image";
  # nix/lean.nix carries nixpkgs overlays (NetworkManager without ModemManager).
  node.pkgsReadOnly = false;

  nodes.machine = { lib, ... }: {
    imports = bridgeModules;
    splancBridge.board = "vm";
    # The image's own default hostname (the test driver would name it after the node).
    # The driver then calls the machine `splanc_bridge`; the script aliases it.
    networking.hostName = lib.mkForce "splanc-bridge";
    splancBridge.latestUrl = "http://127.0.0.1:8000/latest.json";
    splancBridge.updaterExtraArgs = [ "--allow-http" ];
    networking.networkmanager.enable = true;
    virtualisation.memorySize = 1024;
    # No framebuffer in the VM: the display writes the HDMI page to a PNG.
    systemd.services.splanc-display.environment.SPLANC_DISPLAY_HDMI = "png:/run/splanc-display/hdmi.png";
    # The release pointer, served locally.
    systemd.services.stub-splanc-io = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server -b 127.0.0.1 -d ${stubBundle} 8000";
    };
    # Don't let the timer race the test's explicit runs.
    systemd.timers.splanc-agent-update.enable = lib.mkForce false;
  };

  testScript = ''
    import json
    import re

    machine = splanc_bridge

    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("stub-splanc-io.service")
    machine.wait_for_open_port(8000)

    with subtest("baked bundle runs the bridge"):
        machine.wait_until_succeeds("test -s /run/splanc-bridge/status.json", timeout=120)
        machine.succeed("systemctl is-active splanc-bridge.service")
        machine.fail("grep -q 'has no bridge yet' /run/splanc-bridge/status.json")

    with subtest("flash-time boot config"):
        machine.succeed("mkdir -p /boot/firmware/system-connections")
        machine.succeed(
            "printf 'HOSTNAME=Living-Room\\r\\nWIFI_COUNTRY=de\\nSPLANC_RELAY=wss://relay.example.test\\n"
            "OLED=off\\nBOGUS=1\\nOLED_ROTATE=7\\n' > /boot/firmware/splanc-bridge.conf"
        )
        machine.succeed(
            "printf '[connection]\\nid=splanc-wifi\\ntype=wifi\\n[wifi]\\nssid=My WiFi\\n"
            "[wifi-security]\\nkey-mgmt=wpa-psk\\npsk=pa ss;word\\n[ipv4]\\nmethod=auto\\n'"
            " > /boot/firmware/system-connections/splanc-wifi.nmconnection"
        )
        machine.succeed(
            "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC2rVLqdD4mR0yEgwbI2qbmVgbQtQpHqMdx1PkJb1a8d vm@test'"
            " > /boot/firmware/authorized_keys"
        )
        machine.succeed("systemctl restart splanc-flash-config.service")
        assert machine.succeed("hostname").strip() == "living-room"
        nm = "/etc/NetworkManager/system-connections/splanc-wifi.nmconnection"
        assert machine.succeed(f"stat -c '%a %U' {nm}").strip() == "600 root"
        machine.succeed(f"grep -qx 'psk=pa ss;word' {nm}")
        machine.fail("test -e /boot/firmware/system-connections/splanc-wifi.nmconnection")
        env = machine.succeed("cat /run/splanc-flash/bridge.env")
        assert "SPLANC_RELAY=wss://relay.example.test" in env, env
        assert "OLED=off" in env and "BOGUS" not in env and "OLED_ROTATE" not in env, env
        machine.succeed("systemctl start sshd.service")
        machine.wait_for_unit("sshd.service")
        machine.succeed("grep -q vm@test /var/lib/splanc-ssh/authorized_keys")

    with subtest("self-update to a newer bundle, onto the flash-time relay"):
        machine.succeed("systemctl start splanc-agent-update.service")
        assert machine.succeed("readlink /var/lib/splanc-agent/current").strip() == "agent/9.9.9"
        machine.wait_until_succeeds("grep -q '\"state\": *\"pairing\"' /run/splanc-bridge/status.json", timeout=60)
        st = json.loads(machine.succeed("cat /run/splanc-bridge/status.json"))
        assert st["relay"] == "wss://relay.example.test", st
        machine.fail("test -e /var/lib/splanc-agent/.updated")
        machine.succeed("systemctl start splanc-agent-update.service")
        machine.succeed("journalctl -u splanc-agent-update -o cat | grep -q 'up to date (9.9.9)'")
        machine.fail("runuser -u splanc -- touch /var/lib/splanc-agent/agent/9.9.9/mcp/x")

    with subtest("NetworkManager reads the flasher's keyfile exactly (SSID/PSK escaping)"):
        expect = json.loads(machine.succeed("cat ${trickyWifi}/expect.json"))
        machine.succeed("mkdir -p /boot/firmware/system-connections")
        machine.succeed("cp ${trickyWifi}/splanc-wifi.nmconnection /boot/firmware/system-connections/")
        machine.succeed("systemctl restart splanc-flash-config.service")
        machine.succeed("nmcli connection reload")

        def nm_field(field, con="splanc-wifi"):
            # terse output backslash-escapes ':' and '\'
            v = machine.succeed(f"nmcli -s -t -g {field} connection show {con}")
            return re.sub(r"\\(.)", r"\1", v.rstrip("\n"))

        assert nm_field("802-11-wireless.ssid") == expect["ssid"], nm_field("802-11-wireless.ssid")
        assert nm_field("802-11-wireless-security.psk") == expect["psk"], nm_field("802-11-wireless-security.psk")
        assert nm_field("802-11-wireless.hidden") == "yes"

    with subtest("Improv: networks from the phone app are stored like the flasher's"):
        # No Bluetooth adapter in the VM: the service waits for bluetooth.target.
        machine.fail("systemctl is-active splanc-improv.service")
        env = machine.succeed("systemctl show -p Environment splanc-improv.service")
        m = re.search(r"PYTHONPATH=(\S+)", env)
        assert m, env
        improv_py = m.group(1)
        improv = f"PYTHONPATH={improv_py} ${pkgs.python3}/bin/python3 ${./improv_vm.py}"
        nmdir = "/etc/NetworkManager/system-connections"
        out = machine.succeed(f"{improv} store ${trickyWifi}/expect.json")
        # same SSID: replaced in place; a new SSID: added next to it
        assert f"splanc-wifi {nmdir}/splanc-wifi.nmconnection replaced" in out, out
        assert f"splanc-wifi-2 {nmdir}/splanc-wifi-2.nmconnection added" in out, out
        assert nm_field("802-11-wireless.ssid") == expect["ssid"]
        assert nm_field("802-11-wireless-security.psk") == "n3w " + expect["psk"]
        assert nm_field("802-11-wireless.ssid", "splanc-wifi-2") == "Venue Wi-Fi"
        assert nm_field("802-11-wireless-security.psk", "splanc-wifi-2") == "venue-pass"
        assert machine.succeed(f"stat -c '%a %U' {nmdir}/splanc-wifi-2.nmconnection").strip() == "600 root"
        # A full join with the real nmcli: no WiFi device here, so it fails and
        # leaves the saved networks exactly as they were.
        snap = f"sha256sum {nmdir}/*; nmcli -t -f NAME,UUID connection show | sort"
        before = machine.succeed(snap)
        assert machine.succeed(f"{improv} join Elsewhere password1").strip() == "None"
        assert machine.succeed(snap) == before

    with subtest("screens + CLI"):
        machine.wait_for_unit("splanc-display.service")
        machine.wait_until_succeeds("test -s /run/splanc-display/hdmi.png", timeout=60)
        machine.copy_from_vm("/run/splanc-display/hdmi.png", "")
        out = machine.succeed("splanc-bridge status")
        assert "TEST-CODE" in out, out
        out = machine.succeed("splanc-bridge version")
        assert '"board":"vm"' in out and "agent/9.9.9" in out, out
  '';
}
