#!/bin/sh
# Splanc bridge installer for Raspberry Pi OS (Bookworm, Lite or Desktop).
#
#   curl -fsSL https://splanc.io/bridge/install.sh | sudo sh
#   curl -fsSL https://splanc.io/bridge/install.sh | sudo sh -s -- --relay wss://...
#
# Installs, all under /opt/splanc-bridge unless noted:
#   node/        a pinned Node.js (sha256-checked; Debian's is too old)
#   agent/<ver>  the Splanc agent bundle from https://splanc.io/agent/latest.json
#                (sha256-checked), which carries the bridge and this appliance's
#                display service (pi-bridge/)
#   venv/        Python env for the display (hash-pinned wheels + apt packages)
#   /etc/systemd/system/splanc-{bridge,display}.service, splanc-bridge-update.timer
#   /etc/splanc-bridge/bridge.env    settings (kept across updates)
#   /usr/local/bin/splanc-bridge     the CLI (status, new-code, logs, update, ...)
# and turns on SPI for the Waveshare 1.3" OLED HAT (skip with --oled off).
#
# Options:
#   --relay URL        relay the bridge connects to (default: the bridge's own)
#   --oled MODE        auto (default) | spi | i2c | off
#   --bundle FILE      install this splanc-agent-<ver>.tgz instead of downloading
#   --latest URL       release pointer (default https://splanc.io/agent/latest.json)
#   --source DIR       take the display service from a checkout's pi/bridge (dev)
#   --no-start         install + enable, but don't (re)start the services
#   --upgrade          used by `splanc-bridge update`: keep settings, restart
#   --uninstall        remove it (keeps /etc/splanc-bridge, /var/lib/splanc-bridge;
#                      add --purge to remove those too)
#   --root DIR         install into DIR as a fake root (testing: no apt, no
#                      users, no systemctl; implies --no-node unless SPLANC_NODE_TARBALL)
#   --no-apt, --no-node  skip installing apt packages / the pinned Node
#
# The whole script is one function called on its last line, so a truncated
# download (curl | sh) runs nothing.
set -eu

NODE_VERSION=22.23.3
# sha256 of node-v$NODE_VERSION-linux-<arch>.tar.xz, from nodejs.org SHASUMS256.txt
node_sha256() {
  case "$1" in
    arm64) echo a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f ;;
    armv7l) echo 590a2768199bdd0b848648a81cd7f07f88a5ceb27949f0c70d5e6652c3eaca69 ;;
    x64) echo df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de ;;
  esac
}

DEFAULT_LATEST=https://splanc.io/agent/latest.json

APT_REQUIRED="ca-certificates curl xz-utils python3 python3-venv python3-pil python3-cbor2 python3-smbus2 fonts-dejavu-core"
# Pi-specific (Raspberry Pi OS archive); best effort elsewhere.
APT_OPTIONAL="python3-spidev python3-gpiozero python3-lgpio avahi-daemon"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

fetch() { # url dest
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$2" "$1" || die "download failed: $1"
}

json_field() { # file key  (top-level string field)
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v if isinstance(v,str) else "")' "$1" "$2"
}

node_arch() {
  # dpkg's view first: a 32-bit Pi OS on a Pi 4/5 runs a 64-bit kernel
  # (uname -m = aarch64) over armhf userspace, which can't run arm64 Node.
  case "$(dpkg --print-architecture 2>/dev/null || true)" in
    arm64) echo arm64 && return ;;
    armhf) echo armv7l && return ;;
    amd64) echo x64 && return ;;
  esac
  case "$(uname -m)" in
    aarch64 | arm64) echo arm64 ;;
    armv7l | armv8l) echo armv7l ;;
    x86_64 | amd64) echo x64 ;;
    *) die "unsupported CPU $(uname -m): needs a Pi 3/4/5/Zero 2 W (armv7 or 64-bit)" ;;
  esac
}

boot_config() {
  for f in "$ROOT/boot/firmware/config.txt" "$ROOT/boot/config.txt"; do
    if [ -f "$f" ]; then
      echo "$f"
      return
    fi
  done
}

ensure_line() { # file line  (append if no uncommented identical line)
  if ! grep -qxF "$2" "$1" 2>/dev/null; then
    printf '%s\n' "$2" >>"$1"
    CHANGED_BOOT=1
  fi
}

set_env() { # key value  (in $ENVFILE)
  if grep -q "^$1=" "$ENVFILE" 2>/dev/null; then
    sed -i "s|^$1=.*|$1=$2|" "$ENVFILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENVFILE"
  fi
}

install_apt() {
  [ "$NO_APT" = 1 ] && return
  say "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || warn "apt-get update failed; trying with the cached package lists"
  # shellcheck disable=SC2086
  apt-get install -y -qq --no-install-recommends $APT_REQUIRED || die "apt-get install failed"
  for p in $APT_OPTIONAL; do
    apt-get install -y -qq --no-install-recommends "$p" >/dev/null 2>&1 || warn "optional package $p not available"
  done
}

install_user() {
  [ -n "$ROOT" ] && return
  if ! id splanc >/dev/null 2>&1; then
    say "Creating the 'splanc' system user"
    useradd --system --home-dir /var/lib/splanc-bridge --no-create-home --shell /usr/sbin/nologin splanc
  fi
  for g in video tty render gpio spi i2c; do
    if getent group "$g" >/dev/null 2>&1; then
      usermod -aG "$g" splanc
    fi
  done
  # Let the user who ran `sudo` use `splanc-bridge status/new-code` without sudo
  # (from their next login).
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && id "$SUDO_USER" >/dev/null 2>&1; then
    usermod -aG splanc "$SUDO_USER"
  fi
}

install_node() {
  if [ "$NO_NODE" = 1 ]; then
    command -v node >/dev/null 2>&1 || [ -n "$ROOT" ] || die "--no-node, but there is no node on PATH"
    return
  fi
  arch="$(node_arch)"
  dir="$PREFIX/node-v$NODE_VERSION-linux-$arch"
  if [ -x "$dir/bin/node" ]; then
    say "Node.js v$NODE_VERSION already installed"
  else
    want="$(node_sha256 "$arch")"
    tgz="$TMP/node.tar.xz"
    if [ -n "${SPLANC_NODE_TARBALL:-}" ]; then
      cp "$SPLANC_NODE_TARBALL" "$tgz"
    else
      say "Downloading Node.js v$NODE_VERSION ($arch)"
      fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" "$tgz"
    fi
    [ "$(sha256_of "$tgz")" = "$want" ] || die "Node.js download failed its sha256 check"
    mkdir -p "$dir"
    tar -xJf "$tgz" -C "$dir" --strip-components=1 --no-same-owner
  fi
  ln -sfn "node-v$NODE_VERSION-linux-$arch" "$PREFIX/node"
}

get_bundle() {
  if [ -n "$BUNDLE" ]; then
    [ -f "$BUNDLE" ] || die "no such bundle: $BUNDLE"
    cp "$BUNDLE" "$TMP/bundle.tgz"
    if [ -f "$BUNDLE.sha256" ]; then
      [ "$(sha256_of "$TMP/bundle.tgz")" = "$(cut -d' ' -f1 "$BUNDLE.sha256")" ] || die "$BUNDLE failed its sha256 check"
    fi
    return
  fi
  say "Looking up the latest Splanc release"
  fetch "$LATEST" "$TMP/latest.json"
  url="$(json_field "$TMP/latest.json" url)"
  sha="$(json_field "$TMP/latest.json" sha256)"
  ver="$(json_field "$TMP/latest.json" version)"
  [ -n "$url" ] && [ -n "$sha" ] || die "$LATEST has no url/sha256"
  say "Downloading Splanc agent $ver"
  fetch "$url" "$TMP/bundle.tgz"
  [ "$(sha256_of "$TMP/bundle.tgz")" = "$sha" ] || die "agent bundle failed its sha256 check (expected $sha)"
}

fetch_bundle() { # download/verify/unpack first: fail before changing anything
  get_bundle
  mkdir -p "$TMP/unpack"
  tar -xzf "$TMP/bundle.tgz" -C "$TMP/unpack" --no-same-owner
  top="$(ls "$TMP/unpack")"
  [ -f "$TMP/unpack/$top/bundle.json" ] || die "not a splanc-agent bundle"
  VERSION="$(json_field "$TMP/unpack/$top/bundle.json" version)"
  [ -n "$VERSION" ] || die "bundle has no version"
  if [ -n "$SOURCE" ]; then
    say "Using the display service from $SOURCE"
    rm -rf "$TMP/unpack/$top/pi-bridge"
    mkdir -p "$TMP/unpack/$top/pi-bridge"
    for d in bin display systemd; do
      cp -R "$SOURCE/$d" "$TMP/unpack/$top/pi-bridge/"
    done
    cp "$SOURCE/install.sh" "$TMP/unpack/$top/pi-bridge/"
    find "$TMP/unpack/$top/pi-bridge" \( -name __pycache__ -o -name '*.pyc' \) -prune -exec rm -rf {} +
  fi
  [ -d "$TMP/unpack/$top/pi-bridge" ] ||
    die "Splanc $VERSION predates the Pi bridge (its bundle has no pi-bridge/). Try again after the next release."
  UNPACKED="$TMP/unpack/$top"
}

place_bundle() {
  dest="$PREFIX/agent/$VERSION"
  say "Installing Splanc agent $VERSION"
  rm -rf "$dest.new"
  mkdir -p "$PREFIX/agent"
  cp -R "$UNPACKED" "$dest.new"
  rm -rf "$dest"
  mv "$dest.new" "$dest"
  prev="$(readlink "$PREFIX/agent/current" 2>/dev/null || true)"
  ln -sfn "$VERSION" "$PREFIX/agent/current"
  # Keep the previous version (for a manual rollback) and drop older ones.
  for d in "$PREFIX"/agent/*/; do
    old="$(basename "$d")"
    case "$old" in "$VERSION" | "$prev" | current) ;; *) rm -rf "${PREFIX:?}/agent/$old" ;; esac
  done
}

install_venv() {
  lock="$PREFIX/agent/current/pi-bridge/display/requirements.lock"
  venv="$PREFIX/venv"
  if [ -f "$venv/.lock.sha256" ] && [ "$(cat "$venv/.lock.sha256")" = "$(sha256_of "$lock")" ]; then
    return
  fi
  say "Setting up the display's Python environment"
  if [ -n "$ROOT" ] && [ "${SPLANC_TEST_PIP:-0}" != 1 ]; then
    mkdir -p "$venv/bin"
    sha256_of "$lock" >"$venv/.lock.sha256"
    return
  fi
  rm -rf "$venv"
  python3 -m venv --system-site-packages "$venv"
  "$venv/bin/pip" install --isolated --disable-pip-version-check --no-input -q \
    --index-url https://pypi.org/simple --no-deps --require-hashes --only-binary :all: -r "$lock"
  sha256_of "$lock" >"$venv/.lock.sha256"
}

install_config() {
  mkdir -p "$ROOT/etc/splanc-bridge"
  if [ ! -f "$ENVFILE" ]; then
    say "Writing settings to /etc/splanc-bridge/bridge.env"
    cat >"$ENVFILE" <<EOF
# Splanc bridge settings. After editing: sudo systemctl restart splanc-bridge splanc-display
# Relay the bridge connects to (empty: the bridge's built-in default).
SPLANC_RELAY=$RELAY
# Waveshare 1.3" OLED HAT: auto | spi | i2c | off. OLED_ROTATE: 0-3 (x90 degrees).
OLED=$OLED
OLED_ROTATE=2
# HDMI status page: auto | off
SPLANC_DISPLAY_HDMI=auto
# Daily automatic updates (splanc-bridge-update.timer): 1 | 0
SPLANC_AUTO_UPDATE=1
# Extra arguments for \`splanc-agent bridge\`
SPLANC_BRIDGE_ARGS=
EOF
  else
    [ "$RELAY_SET" = 1 ] && set_env SPLANC_RELAY "$RELAY"
    [ "$OLED_SET" = 1 ] && set_env OLED "$OLED"
  fi
  # The effective OLED mode (an upgrade keeps the saved one).
  OLED="$(sed -n 's/^OLED=//p' "$ENVFILE" 2>/dev/null | tail -n1)"
  OLED="${OLED:-auto}"
}

enable_bus() {
  [ "$OLED" = off ] && return
  cfg="$(boot_config)"
  if [ -z "$cfg" ]; then
    warn "no /boot/firmware/config.txt: not a Raspberry Pi OS image? (skipping SPI/I2C setup)"
    return
  fi
  if [ "$OLED" = i2c ]; then
    ensure_line "$cfg" "dtparam=i2c_arm=on"
    [ -z "$ROOT" ] && command -v dtparam >/dev/null 2>&1 && dtparam i2c_arm=on 2>/dev/null || true
  else
    ensure_line "$cfg" "dtparam=spi=on"
    # Live, so the HAT works before the next reboot.
    [ -z "$ROOT" ] && command -v dtparam >/dev/null 2>&1 && dtparam spi=on 2>/dev/null || true
  fi
  # The HAT's keys are active-low with no pull-ups on the board: pull them up
  # from boot (the display service also enables the SoC pull-ups).
  ensure_line "$cfg" "gpio=6,19,5,26,13,21,20,16=pu"
}

install_units() {
  src="$PREFIX/agent/current/pi-bridge"
  unitdir="$ROOT/etc/systemd/system"
  mkdir -p "$unitdir" "$ROOT/usr/local/bin"
  for u in splanc-bridge.service splanc-display.service splanc-bridge-update.service splanc-bridge-update.timer; do
    install -m 0644 "$src/systemd/$u" "$unitdir/$u"
  done
  chmod 0755 "$src/bin/splanc-bridge" "$src/bin/splanc-bridge-run" "$src/install.sh"
  ln -sfn "${PREFIX#"$ROOT"}/agent/current/pi-bridge/bin/splanc-bridge" "$ROOT/usr/local/bin/splanc-bridge"
  [ -n "$ROOT" ] && return
  if [ ! -d /run/systemd/system ]; then
    # A chroot / image build (e.g. pi-gen): enable for the next boot by hand.
    warn "systemd is not running here: enabling the units for the next boot only"
    mkdir -p /etc/systemd/system/multi-user.target.wants /etc/systemd/system/timers.target.wants
    ln -sfn ../splanc-bridge.service /etc/systemd/system/multi-user.target.wants/splanc-bridge.service
    ln -sfn ../splanc-display.service /etc/systemd/system/multi-user.target.wants/splanc-display.service
    ln -sfn ../splanc-bridge-update.timer /etc/systemd/system/timers.target.wants/splanc-bridge-update.timer
    NO_START=1
    return
  fi
  systemctl daemon-reload
  systemctl enable splanc-bridge.service splanc-display.service splanc-bridge-update.timer >/dev/null 2>&1
  [ "$NO_START" = 1 ] && return
  systemctl restart splanc-bridge.service splanc-display.service
  systemctl start splanc-bridge-update.timer
}

uninstall() {
  say "Removing the Splanc bridge"
  if [ -z "$ROOT" ]; then
    systemctl disable --now splanc-bridge.service splanc-display.service splanc-bridge-update.timer 2>/dev/null || true
  fi
  for u in splanc-bridge.service splanc-display.service splanc-bridge-update.service splanc-bridge-update.timer; do
    rm -f "$ROOT/etc/systemd/system/$u"
  done
  rm -f "$ROOT/usr/local/bin/splanc-bridge"
  rm -rf "$PREFIX"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$ROOT/etc/splanc-bridge" "$ROOT/var/lib/splanc-bridge" "$ROOT/var/cache/splanc-bridge"
    [ -z "$ROOT" ] && id splanc >/dev/null 2>&1 && userdel splanc
  fi
  [ -z "$ROOT" ] && { systemctl daemon-reload 2>/dev/null || true; }
  say "Done. (Settings kept in /etc/splanc-bridge unless --purge.)"
}

show_result() {
  [ -n "$ROOT" ] && return
  if [ "$UPGRADE" = 1 ]; then
    say "Splanc bridge updated to $VERSION."
    return
  fi
  [ "$NO_START" = 1 ] && return
  i=0
  while [ $i -lt 20 ] && [ ! -f /run/splanc-bridge/status.json ]; do
    sleep 1
    i=$((i + 1))
  done
  echo
  "$ROOT/usr/local/bin/splanc-bridge" status 2>/dev/null || true
  echo
  ip="$(hostname -I 2>/dev/null | cut -d' ' -f1)"
  say "Splanc bridge $VERSION is running."
  echo "    The pairing code is on the HDMI screen / OLED HAT, or run:  splanc-bridge status"
  echo "    Logs: splanc-bridge logs      Settings: /etc/splanc-bridge/bridge.env"
  [ -n "$ip" ] && echo "    This Pi: $ip ($(hostname).local)"
  if [ "$CHANGED_BOOT" = 1 ]; then
    echo "    SPI/GPIO settings were added to the boot config; they are live now and"
    echo "    persist from the next reboot."
  fi
}

main() {
  ROOT=""
  RELAY=""
  RELAY_SET=0
  OLED=auto
  OLED_SET=0
  BUNDLE=""
  LATEST="$DEFAULT_LATEST"
  SOURCE=""
  NO_START=0
  UPGRADE=0
  UNINSTALL=0
  PURGE=0
  NO_APT=0
  NO_NODE=0
  CHANGED_BOOT=0
  VERSION=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --relay) RELAY="${2:?--relay needs a URL}" RELAY_SET=1 && shift ;;
      --oled)
        OLED="${2:?--oled needs auto|spi|i2c|off}" OLED_SET=1 && shift
        case "$OLED" in auto | spi | i2c | off) ;; *) die "--oled: auto|spi|i2c|off" ;; esac
        ;;
      --bundle) BUNDLE="${2:?}" && shift ;;
      --latest) LATEST="${2:?}" && shift ;;
      --source) SOURCE="$(cd "${2:?}" && pwd)" && shift ;;
      --root) ROOT="$(mkdir -p "${2:?}" && cd "$2" && pwd)" && shift ;;
      --no-start) NO_START=1 ;;
      --upgrade) UPGRADE=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      --no-apt) NO_APT=1 ;;
      --no-node) NO_NODE=1 ;;
      -h | --help)
        sed -n '2,/^set -eu/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' | grep -v '^set -eu' || echo "see https://github.com/fughilli/splanc/blob/main/docs/pi-bridge.md"
        exit 0
        ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  PREFIX="$ROOT/opt/splanc-bridge"
  ENVFILE="$ROOT/etc/splanc-bridge/bridge.env"
  if [ -n "$ROOT" ]; then
    NO_APT=1
    [ -z "${SPLANC_NODE_TARBALL:-}" ] && NO_NODE=1
  elif [ "$(id -u)" != 0 ]; then
    die "run as root:  curl -fsSL https://splanc.io/bridge/install.sh | sudo sh"
  fi
  if [ "$UNINSTALL" = 1 ]; then
    uninstall
    return
  fi
  if [ -z "$ROOT" ] && [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    [ "${VERSION_CODENAME:-}" = bookworm ] || warn "made for Raspberry Pi OS Bookworm; this is ${PRETTY_NAME:-unknown}"
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT INT TERM
  install_apt
  fetch_bundle
  install_user
  mkdir -p "$PREFIX"
  install_node
  place_bundle
  install_venv
  install_config
  enable_bus
  install_units
  show_result
}

main "$@"
