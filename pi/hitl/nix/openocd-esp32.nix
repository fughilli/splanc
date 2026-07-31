# Espressif's OpenOCD fork — the only OpenOCD that supports the ESP32-C6's
# (RISC-V) built-in USB-JTAG. Mainline nixpkgs openocd only covers the Xtensa
# esp32/s2/s3. Prebuilt release binary, autopatchelf'd onto nixpkgs libs.
{ pkgs }:
let
  version = "0.12.0-esp32-20260703";
in
pkgs.stdenv.mkDerivation {
  pname = "openocd-esp32";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://github.com/espressif/openocd-esp32/releases/download/v${version}/openocd-esp32-linux-arm64-${version}.tar.gz";
    hash = "sha256-POBZompUPpaxm+8VopuFCq2v8dTi3CkejBq0XjMaXxw=";
  };

  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.libusb1
    pkgs.zlib
    pkgs.libgcrypt
    pkgs.libgpg-error
  ];

  # The tarball unpacks to ./openocd-esp32/{bin,share,...}.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r ./* $out/
    runHook postInstall
  '';

  meta.description = "Espressif OpenOCD fork with ESP32-C6 USB-JTAG support";
}
