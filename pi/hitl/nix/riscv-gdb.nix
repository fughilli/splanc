# Espressif's prebuilt riscv32-esp-elf-gdb — the GDB client for the ESP32-C6
# (RISC-V). Connects to the openocd gdbserver (see openocd-esp32.nix). nixpkgs has
# no riscv32 gdb; the host gdb can't debug the target.
{ pkgs }:
let
  version = "17.1_20260402";
  # Select the prebuilt asset by host arch (see openocd-esp32.nix): arm64 Pi rigs
  # vs the x86_64 amd-rig SDR bench. Pinning aarch64 unconditionally shipped an
  # aarch64 gdb onto the x86_64 amd-rig.
  system = pkgs.stdenv.hostPlatform.system;
  asset = {
    "aarch64-linux" = {
      triple = "aarch64-linux-gnu";
      hash = "sha256-8YXZJEl3UPJUKQoyxIFjwI47KinrJI1znZCZDr7hf0Q=";
    };
    "x86_64-linux" = {
      triple = "x86_64-linux-gnu";
      hash = "sha256-NfPbhBM4y0+bxg11e8PoffpQ/1Bge8vDhnxbGsKN00I=";
    };
  }.${system} or (throw "riscv32-esp-elf-gdb: unsupported system ${system}");
in
pkgs.stdenv.mkDerivation {
  pname = "riscv32-esp-elf-gdb";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://github.com/espressif/binutils-gdb/releases/download/esp-gdb-v${version}/riscv32-esp-elf-gdb-${version}-${asset.triple}.tar.gz";
    inherit (asset) hash;
  };

  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
    pkgs.ncurses
    pkgs.expat
    pkgs.xz
  ];

  # Unpacks to ./riscv32-esp-elf-gdb/{bin,...}. The tarball ships one gdb per
  # Python version (3.8–3.14) + a python-dispatch wrapper; keep only the
  # no-python build (enough for HITL: bt/reg/mem/breakpoints) and point the main
  # name at it, so autoPatchelf doesn't chase seven libpython versions.
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r ./* $out/
    rm -f $out/bin/riscv32-esp-elf-gdb-3.* $out/bin/riscv32-esp-elf-gdb
    ln -s riscv32-esp-elf-gdb-no-python $out/bin/riscv32-esp-elf-gdb
    runHook postInstall
  '';

  meta.description = "Espressif riscv32-esp-elf GDB (ESP32-C6 debugging)";
}
