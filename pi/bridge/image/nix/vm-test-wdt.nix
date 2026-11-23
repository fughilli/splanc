# QEMU test of the stage-1 watchdog (nix/boot-watchdog.nix, pi/bridge/splash/splanc-wdt.c).
#
#   nix build ./pi/bridge/image#checks.aarch64-linux.vm-wdt -L
#   # no KVM: nix build ...#checks.aarch64-linux.vm-wdt.driver -o driver && ./driver/bin/nixos-test-driver
#
# Two minimal systems with an emulated i6300esb watchdog (the VM's stand-in for
# the Pi's bcm2835 one; QEMU resets the guest when it fires, and the test
# driver's QEMU runs with -no-reboot, so a reset ends the VM):
#   ok     boots normally: splanc-wdt arms the watchdog in stage 1, hands it over
#          once systemd is PID 1, and systemd takes it over (no reset meanwhile);
#   stall  stage 1 hangs (a sleep after the devices are up, no panic): splanc-wdt
#          gives up at its deadline and the watchdog resets the VM.
# (60 s timeouts instead of the Pi's 15 s: TCG is slow.)
{ pkgs }:
pkgs.testers.runNixOSTest {
  name = "splanc-bridge-boot-watchdog";

  defaults = {
    imports = [ ./boot-watchdog.nix ];
    # Longer than the Pi's 15 s: under TCG (no KVM) systemd takes ~12 s from
    # its exec to opening the watchdog.
    systemd.watchdog.runtimeTime = "60s";
    boot.kernelParams = [ "splanc.wdt_timeout=60" ];
    boot.initrd.kernelModules = [ "i6300esb" ];
    virtualisation.qemu.options = [ "-device i6300esb" ];
    virtualisation.memorySize = 512;
    boot.consoleLogLevel = 7; # splanc-wdt's kernel-log lines on the serial console
  };

  nodes.ok = { };
  nodes.stall = {
    boot.kernelParams = [ "splanc.boot_deadline=40" ];
    boot.initrd.postDeviceCommands = ''
      echo "splanc-test: stalling stage 1"
      while :; do :; done  # (no `sleep` in the initrd's tools)
    '';
  };

  testScript = ''
    import time

    start_all()

    with subtest("a normal boot: armed in stage 1, handed over to systemd"):
        ok.wait_for_unit("multi-user.target")
        klog = ok.succeed("dmesg | grep splanc-wdt")
        print(klog)
        assert "armed /dev/watchdog0 (60 s)" in klog, klog
        assert "handing the watchdog over" in klog, klog
        ok.fail("pgrep -f '^@splanc-wdt'")
        jr = ok.succeed("journalctl -b -o cat | grep -i 'watchdog'")
        print(jr)
        assert "Using hardware watchdog" in jr, jr
        # (and nothing reset the VM meanwhile: -no-reboot would have ended it)
        assert ok.succeed("cat /sys/class/watchdog/watchdog0/state").strip() == "active"

    with subtest("a stalled stage 1 resets the board at the deadline"):
        # -no-reboot: the watchdog's reset ends the VM.
        deadline = time.monotonic() + 900
        assert stall.process is not None
        while stall.process.poll() is None:
            assert time.monotonic() < deadline, "the stalled VM was never reset"
            time.sleep(5)
        time.sleep(2)  # (the console reader's last lines)
        lines = []
        while not stall.last_lines.empty():
            lines.append(stall.last_lines.get())
        console = "".join(lines)
        assert "splanc-wdt: armed /dev/watchdog0 (60 s)" in console, console[-3000:]
        assert "did not reach systemd within 40 s" in console, console[-3000:]
        assert "systemd[1]" not in console, "the stalled VM reached systemd"
  '';
}
