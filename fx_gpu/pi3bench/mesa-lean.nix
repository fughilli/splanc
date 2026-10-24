# Lean Mesa for the Pi 3 benchmark bundle (aarch64): vc4 (Pi 0-3) + v3d (Pi 4/5)
# gallium + broadcom Vulkan, NO LLVM. Mirrors td-deploy deploy/nix/mesa-lean.nix,
# plus the extra knobs Mesa 26 (nixpkgs-unstable) needs: mesa-clc / intel-rt /
# tools / video-codecs / vulkan-layers off, and the rusticl postFixup dropped.
# Build: nix build --impure --expr '(import ./mesa-lean.nix).mesa'
let
  pkgs = import (builtins.getFlake "nixpkgs") { };
  lib = pkgs.lib;
  mesaLean = (pkgs.mesa.override {
    galliumDrivers = [ "vc4" "v3d" ];
    vulkanDrivers = [ "broadcom" ];
  }).overrideAttrs (old: {
    mesonFlags = (old.mesonFlags or [ ]) ++ [
      (lib.mesonEnable "llvm" false)
      (lib.mesonBool "gallium-rusticl" false)
      (lib.mesonEnable "gallium-va" false)
      (lib.mesonBool "teflon" false)
      # mesa 26 (nixpkgs-unstable) extras that pull clang/LLVM (mesa-clc, intel-rt):
      (lib.mesonBool "install-mesa-clc" false)
      (lib.mesonBool "install-precomp-compiler" false)
      (lib.mesonEnable "intel-rt" false)
      "-Dtools="
      "-Dvideo-codecs="
      "-Dvulkan-layers="
    ];
    # rusticl is off: drop the stock postFixup lines that patchelf libRusticlOpenCL.so
    postFixup = builtins.concatStringsSep "\n" (builtins.filter (l: !(lib.hasInfix "Rusticl" l))
      (lib.splitString "\n" (old.postFixup or "")));
    postInstall = (old.postInstall or "") + ''
      mkdir -p "$spirv2dxil" "$opencl" "$cross_tools"
      rm -f "$out/bin/mesa-overlay-control.py"
    '';
  });
in
{
  mesa = mesaLean;
  # full nixpkgs Mesa (with llvmpipe) — ONLY for the host self-test of the bundle
  mesaFull = pkgs.mesa;
  glvnd = pkgs.libglvnd;
  glibc = pkgs.glibc;
  patchelf = pkgs.patchelf;
}
