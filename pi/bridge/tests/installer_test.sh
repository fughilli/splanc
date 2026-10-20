#!/bin/sh
# install.sh end to end into a fake root (--root: no apt, users, systemctl or
# network): fresh install, upgrade (settings kept, boot config not duplicated,
# old versions pruned), sha256 + bundle checks, uninstall/purge, and
# `systemd-analyze verify` of the installed units where systemd is available.
#
#   bazel test //pi/bridge:installer_test      (or: sh pi/bridge/tests/installer_test.sh)
set -eu

if [ -n "${TEST_SRCDIR:-}" ] && [ -d "$TEST_SRCDIR/_main/pi/bridge" ]; then
  SRC="$TEST_SRCDIR/_main/pi/bridge"
else
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
fi
T="$(mktemp -d "${TEST_TMPDIR:-/tmp}/installer-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
fails=0

ok() { echo "ok   - $*"; }
bad() {
  echo "FAIL - $*"
  fails=$((fails + 1))
}
check() { # description, command...
  d="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
count() { grep -cxF "$2" "$1" || true; }

# A bundle shaped like //agent:bundle's: bundle.json + mcp/ + pi-bridge/.
mkbundle() { # version [no-pi-bridge]
  b="$T/b-$1/splanc-agent-$1"
  mkdir -p "$b/mcp"
  printf '{"schema":"splanc-agent-bundle/1","version":"%s"}\n' "$1" >"$b/bundle.json"
  printf '#!/usr/bin/env node\n' >"$b/mcp/splanc-agent.mjs"
  if [ "${2:-}" != no-pi-bridge ]; then
    mkdir -p "$b/pi-bridge"
    cp -RL "$SRC/bin" "$SRC/display" "$SRC/systemd" "$SRC/install.sh" "$b/pi-bridge/"
  fi
  tar -czf "$T/splanc-agent-$1.tgz" -C "$T/b-$1" "splanc-agent-$1"
  (cd "$T" && sha256sum "splanc-agent-$1.tgz" >"splanc-agent-$1.tgz.sha256")
  echo "$T/splanc-agent-$1.tgz"
}

R="$T/root"
mkdir -p "$R/boot/firmware"
printf '# stock\n#dtparam=spi=on\ndtparam=audio=on\n' >"$R/boot/firmware/config.txt"
INST="$SRC/install.sh"

# --- fresh install -------------------------------------------------------------
check "install 1.0.0" sh "$INST" --root "$R" --bundle "$(mkbundle 1.0.0)" --relay wss://relay.example --no-start
O="$R/opt/splanc-bridge"
check "agent/current -> 1.0.0" test "$(readlink "$O/agent/current")" = 1.0.0
check "display package installed" test -f "$O/agent/current/pi-bridge/display/splanc_display/main.py"
for u in splanc-bridge.service splanc-display.service splanc-bridge-update.service splanc-bridge-update.timer; do
  check "unit $u" test -f "$R/etc/systemd/system/$u"
done
check "CLI symlink points into the live bundle" test "$(readlink "$R/usr/local/bin/splanc-bridge")" = /opt/splanc-bridge/agent/current/pi-bridge/bin/splanc-bridge
check "CLI executable" test -x "$O/agent/current/pi-bridge/bin/splanc-bridge"
check "bridge runner executable" test -x "$O/agent/current/pi-bridge/bin/splanc-bridge-run"
E="$R/etc/splanc-bridge/bridge.env"
check "relay saved" grep -qx "SPLANC_RELAY=wss://relay.example" "$E"
check "OLED=auto by default" grep -qx "OLED=auto" "$E"
C="$R/boot/firmware/config.txt"
check "SPI enabled" test "$(count "$C" dtparam=spi=on)" = 1
check "HAT key pull-ups" test "$(count "$C" gpio=6,19,5,26,13,21,20,16=pu)" = 1
check "commented stock line untouched" grep -qx "#dtparam=spi=on" "$C"
check "venv lock stamp" test -f "$O/venv/.lock.sha256"

# --- upgrade: settings kept, no duplicate boot lines, old versions pruned -------
check "upgrade to 1.1.0" sh "$INST" --root "$R" --bundle "$(mkbundle 1.1.0)" --upgrade --no-start
check "agent/current -> 1.1.0" test "$(readlink "$O/agent/current")" = 1.1.0
check "previous version kept for rollback" test -d "$O/agent/1.0.0"
check "relay kept across upgrade" grep -qx "SPLANC_RELAY=wss://relay.example" "$E"
check "SPI line not duplicated" test "$(count "$C" dtparam=spi=on)" = 1
check "upgrade to 1.2.0 + --oled off" sh "$INST" --root "$R" --bundle "$(mkbundle 1.2.0)" --oled off --no-start
check "1.0.0 pruned" test ! -d "$O/agent/1.0.0"
check "1.1.0 kept" test -d "$O/agent/1.1.0"
check "OLED=off saved" grep -qx "OLED=off" "$E"
check "relay still kept" grep -qx "SPLANC_RELAY=wss://relay.example" "$E"

# --- I2C mode turns on I2C ------------------------------------------------------
check "reinstall with --oled i2c" sh "$INST" --root "$R" --bundle "$T/splanc-agent-1.2.0.tgz" --oled i2c --no-start
check "I2C enabled" test "$(count "$C" dtparam=i2c_arm=on)" = 1

# --- refusals -------------------------------------------------------------------
tgz="$(mkbundle 2.0.0)"
echo "0000000000000000000000000000000000000000000000000000000000000000  x" >"$tgz.sha256"
if sh "$INST" --root "$R" --bundle "$tgz" --no-start >"$T/out" 2>&1; then
  bad "tampered bundle rejected"
else
  grep -q "sha256" "$T/out" && ok "tampered bundle rejected" || bad "tampered bundle: wrong message"
fi
check "still on 1.2.0 after the refusal" test "$(readlink "$O/agent/current")" = 1.2.0
if sh "$INST" --root "$R" --bundle "$(mkbundle 0.9.0 no-pi-bridge)" --no-start >"$T/out" 2>&1; then
  bad "bundle without pi-bridge rejected"
else
  grep -q "predates the Pi bridge" "$T/out" && ok "bundle without pi-bridge rejected" || bad "no-pi-bridge: wrong message"
fi
if sh "$INST" --root "$R" --oled bogus >"$T/out" 2>&1; then bad "bad --oled rejected"; else ok "bad --oled rejected"; fi
if sh "$INST" --frobnicate >"$T/out" 2>&1; then bad "unknown option rejected"; else ok "unknown option rejected"; fi

# --- CLI over the fake root (status with no bridge running) -----------------------
if command -v python3 >/dev/null 2>&1; then
  out="$(SPLANC_PREFIX="$O" SPLANC_BRIDGE_STATUS="$T/none.json" sh "$O/agent/current/pi-bridge/bin/splanc-bridge" status 2>&1 || true)"
  case "$out" in *"Waiting for bridge"*) ok "CLI status without a bridge" ;; *) bad "CLI status: $out" ;; esac
fi

# --- systemd unit validation (where systemd-analyze exists) -----------------------
if command -v systemd-analyze >/dev/null 2>&1; then
  mkdir -p "$T/units"
  for u in "$R"/etc/systemd/system/*; do
    # Point ExecStart at a real executable so verify checks the rest of the unit.
    sed -e 's|^ExecStart=.*|ExecStart=/bin/true|' "$u" >"$T/units/$(basename "$u")"
  done
  if systemd-analyze verify "$T"/units/* >"$T/verify" 2>&1 && ! grep -qiE "unknown|invalid|failed to parse" "$T/verify"; then
    ok "systemd-analyze verify"
  else
    # Containers without a running systemd can't load some referenced units;
    # only syntax problems count.
    if grep -qiE "unknown (key|section)|invalid|failed to parse" "$T/verify"; then
      cat "$T/verify"
      bad "systemd-analyze verify"
    else
      ok "systemd-analyze verify (syntax; environment notes: $(wc -l <"$T/verify") lines)"
    fi
  fi
else
  echo "skip - systemd-analyze not installed"
fi

# --- uninstall ------------------------------------------------------------------------
check "uninstall" sh "$INST" --root "$R" --uninstall
check "opt removed" test ! -e "$O"
check "units removed" test ! -e "$R/etc/systemd/system/splanc-bridge.service"
check "CLI removed" test ! -e "$R/usr/local/bin/splanc-bridge"
check "settings kept" test -f "$E"
check "purge" sh "$INST" --root "$R" --uninstall --purge
check "settings purged" test ! -e "$R/etc/splanc-bridge"

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all installer checks passed"
