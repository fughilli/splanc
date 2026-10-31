# DIAGNOSTIC ONLY (branch bridge/diag-bootloop, not for landing): a Pi 3A+ boot
# loops at the splash's "Loading system…". The journal is volatile and the
# 15 s hardware watchdog resets before the kernel's lockup detectors (~21 s)
# report, so nothing survives. This image:
#   * copies the kernel log, the journal and a 2 s CPU/memory sample to the FAT
#     partition (readable on any computer) as boot runs, synced every second:
#     /boot/firmware/splanc-bootlog/boot-<n>-{kernel,journal,top}.txt (last 6 boots);
#   * turns the hardware watchdog off, so a hang stays hung and gets reported;
#   * has the splash log its frame timing every 10 s (splanc.splash_stats=1).
{ lib, pkgs, ... }:
let
  script = pkgs.writeShellScript "splanc-bootlog" ''
    set -u
    export PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.util-linux pkgs.procps pkgs.systemd pkgs.gawk ]}
    d=/boot/firmware/splanc-bootlog
    mkdir -p "$d"
    n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$d/count"
    rm -f "$d"/boot-$((n - 6))-*.txt
    p="$d/boot-$n"
    echo "boot $n, uptime $(cut -d' ' -f1 /proc/uptime) s, $(uname -a)" > "$p-top.txt"
    dmesg --follow > "$p-kernel.txt" 2>&1 &
    journalctl -b -f -o short-monotonic --no-pager > "$p-journal.txt" 2>&1 &
    (
      while :; do
        {
          echo "== $(cut -d' ' -f1 /proc/uptime) s  load $(cat /proc/loadavg)"
          grep -E '^(MemFree|MemAvailable|Cached|Mlocked|SwapFree):' /proc/meminfo | tr -s ' ' | paste -sd' '
          cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null | sed 's/^/psi /'
          top -b -n1 -w 160 | sed -n '7,22p'
        } >> "$p-top.txt" 2>&1
        sleep 2
      done
    ) &
    while :; do sync -f "$p-top.txt"; sleep 1; done
  '';
in
{
  systemd.watchdog.runtimeTime = lib.mkForce null;
  boot.kernelParams = [ "splanc.splash_stats=1" "softlockup_all_cpu_backtrace=1" ];
  boot.kernel.sysctl."kernel.hung_task_timeout_secs" = 30;

  systemd.services.splanc-bootlog = {
    description = "DIAGNOSTIC: copy the boot logs to the FAT partition as boot runs";
    wantedBy = [ "sysinit.target" ];
    after = [ "systemd-journald.service" ];
    unitConfig = {
      DefaultDependencies = false;
      RequiresMountsFor = [ "/boot/firmware" ];
    };
    serviceConfig = {
      ExecStart = script;
      Nice = -15;
      CPUSchedulingPolicy = "rr";
      CPUSchedulingPriority = 20; # above the splash's FIFO 10, so a spinning splash can't starve it
    };
  };
}
