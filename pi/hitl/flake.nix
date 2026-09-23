{
  # HITL rig — Raspberry Pi image + live-deploy (sbc-deploy consumer). The
  # reservation daemon + client CLI are the generalized hitl-reserve module
  # (github.com/fughilli/hitl-reserve), built from the `hitl-reserve` input below.
  # See DESIGN.md and reserve/README.md.
  #
  # Built via `//pi/hitl:hitl.*` (image_sd / image_sd_base / deploy_live / ssh /
  # keys). The CLI is `packages.<system>.hitl` for agents to `nix run` / install.
  description = "HITL rig — Pi test bench + agent CLI (sbc-deploy consumer)";

  # Build-time substituter for the machine that BUILDS the closure (the deployer:
  # this dev container, a rig, or the Mac's builder VM) — so `nix build` pulls the
  # kernel etc. from the self-hosted Attic cache instead of rebuilding from source.
  # sbc-deploy passes --accept-flake-config (#22), so this is honored non-interactively.
  # The matching ON-RIG substituter is nix/attic-substituter.nix (baked into the system).
  nixConfig = {
    extra-substituters = [ "http://attic.tail6b8ad3.ts.net:8080/splanc" ];
    extra-trusted-public-keys = [ "splanc:MWmTqIgwyOOGTh2wazhPPnVAsIIAV9pEXqhhorIWdvw=" ];
  };

  inputs = {
    # sbc-deploy main @ 23c03bd. Carries the cache-aware deploy series #22–#26:
    # #25 adds the `attic_cache`/`attic_endpoint` sbc_application attrs (best-effort
    # post-build closure push to Attic — //pi/hitl:BUILD wires them to the tag:attic
    # node); #22 --accept-flake-config, #23 nix copy --substitute-on-destination,
    # #24 --tailscale-ssh, #26 secret_tool. Earlier: #18 (deploy_live hardware guard
    # is family-aware — x86 identity via SMBIOS, not the Pi-only device-tree model),
    # #16 (amd64/x86_64 `amd64-generic` board → image_installer + deploy_live, the
    # amd-rig `hitl_sdr` variant), #14/#15 (hermetic flake_srcs staging, macOS fixes),
    # #7/#8 (persistent hostname identity, `update` autodetect). Kept in lockstep with
    # the @sbc_deploy git_override in //MODULE.bazel. (#22–#26 also touch nix/, so
    # this ?dir=nix input's narHash moves in step with the deploy scripts.)
    sbc-deploy.url = "github:fughilli/sbc-deploy/23c03bdcefa0cd4b90ea1ec611456984d91a389a?dir=nix";
    nixpkgs.follows = "sbc-deploy/nixpkgs";

    # The generalized reservation system. Not a flake (plain Go module source);
    # buildGoModule consumes it in nix/packages.nix. Kept in lockstep with the
    # @hitl_reserve git_override in //MODULE.bazel — bump both together. main @
    # 825d155 (PR #6: WS2812 capture pre-trigger, see the MODULE.bazel comment).
    hitl-reserve = {
      url = "github:fughilli/hitl-reserve/825d1554bbff27460b8a6a869b82448e4135c006";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, sbc-deploy, hitl-reserve, ... }:
    let
      # Board family flows in from Bazel via the sbc_application `board` attr, read
      # here through the same getEnv-at-eval (--impure) seam sbc-deploy uses for
      # $SBC_BOARD / $SBC_HOSTNAME_OVERRIDE. The Pi variants (//pi/hitl:hitl,
      # :hitl_pi3) leave it unset ⇒ "" ⇒ the raspberrypi rig; //pi/hitl:hitl_sdr
      # (board = amd64-generic) sets it to "x86_64" ⇒ the amd-rig SDR bench below.
      isX86 = builtins.getEnv "SBC_BOARD_FAMILY" == "x86_64";

      project = sbc-deploy.lib.mkSbcProject {
        # amd-rig is the one x86_64 SDR bench; the Pi fleet shares hitl-rig (the
        # per-board machine identity is the deploy-time --hostname, not this). The
        # hostName IS the nixosConfigurations attr deploy_live builds, so it must
        # match the sbc_application `hostname` attr (amd-rig / hitl-rig).
        hostName = if isX86 then "amd-rig" else "hitl-rig";
        # Ignored when family = x86_64 (mkSbcSystem builds a stock-nixpkgs system);
        # kept for the Pi variants, whose board comes in via $SBC_BOARD.
        board = "raspberry-pi-5";
        # x86_64 → the SDR bench: the C6 + HackRF composite, hackrf/GNU Radio tools,
        # no provisioning-AP/FX2 (see nix/hitl-sdr.nix). raspberrypi → the Pi rig:
        # hitl-app.nix + alloy. Both app modules are FUNCTIONS of the hitl-reserve
        # source (so they build the daemon/CLI from it); apply here for the value.
        #
        # observability/alloy.nix is opt-in but safe to always import: its
        # hitl-alloy service is gated on /var/lib/hitl/grafana.env existing
        # (ConditionPathExists), so a rig without Grafana creds just doesn't
        # start it. Seed the creds with `bazel run //pi/hitl:seed_grafana`.
        # amd-rig (x86_64) runs TWO reservation daemons: the SDR bench (hitl-sdr.nix,
        # privileged/net-host, one composite unit) and — additively — the phone bench
        # (hitl-phone-daemon.nix, isolated multi-DUT: android-phone + android-emu units).
        # ./nix/attic-substituter.nix (both families): the self-hosted Attic cache as
        # a trusted substituter, so a deploy's --substitute-on-destination and on-rig
        # nix pull the kernel etc. from the cache instead of rebuilding. See flake.nix
        # nixConfig for the matching build-time (deployer) substituter.
        appModules =
          if isX86
          then [
            (import ./nix/hitl-sdr.nix { hitlSrc = hitl-reserve; })
            (import ./nix/hitl-phone-daemon.nix { hitlSrc = hitl-reserve; })
            ./nix/hitl-amd-ap.nix
            ./nix/attic-substituter.nix
            ./observability/alloy.nix
          ]
          else [
            (import ./nix/hitl-app.nix { hitlSrc = hitl-reserve; })
            ./nix/attic-substituter.nix
            ./observability/alloy.nix
          ];
        # systemModules = [ sbc-deploy.nixosModules.spi ];  # if the DUT needs SPI
      };

      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems f;
    in
    project // {
      # The hitl CLI for agents (claude-container): `nix run …#hitl -- reserve`.
      packages = forAll (system:
        let hitl = nixpkgs.legacyPackages.${system}.callPackage ./nix/packages.nix { src = hitl-reserve; };
        in { inherit hitl; default = hitl; });
    };
}
