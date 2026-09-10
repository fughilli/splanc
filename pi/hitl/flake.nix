{
  # HITL rig — Raspberry Pi image + live-deploy (sbc-deploy consumer). The
  # reservation daemon + client CLI are the generalized hitl-reserve module
  # (github.com/fughilli/hitl-reserve), built from the `hitl-reserve` input below.
  # See DESIGN.md and reserve/README.md.
  #
  # Built via `//pi/hitl:hitl.*` (image_sd / image_sd_base / deploy_live / ssh /
  # keys). The CLI is `packages.<system>.hitl` for agents to `nix run` / install.
  description = "HITL rig — Pi test bench + agent CLI (sbc-deploy consumer)";

  inputs = {
    # sbc-deploy main @ ccc7dd0 (#16 amd64/x86_64 support: an `amd64-generic` board
    # whose family = "x86_64" swaps mkSbcSystem to a stock-nixpkgs UEFI system and
    # gives image_installer + deploy_live — the amd-rig `hitl_sdr` variant rides
    # this). Also carries #14/#15 (hermetic flake_srcs staging, macOS fixes) and
    # #7/#8 (persistent hostname identity, `update` autodetect). Kept in lockstep
    # with the @sbc_deploy git_override in //MODULE.bazel.
    sbc-deploy.url = "github:fughilli/sbc-deploy/ccc7dd0d48b5b687f896264538789344dffa0edd?dir=nix";
    nixpkgs.follows = "sbc-deploy/nixpkgs";

    # The generalized reservation system. Not a flake (plain Go module source);
    # buildGoModule consumes it in nix/packages.nix. Kept in lockstep with the
    # @hitl_reserve git_override in //MODULE.bazel — bump both together. main @
    # 51c57f6 (PR #4: --net-host for the amd-rig SDR bench, see the MODULE.bazel comment).
    hitl-reserve = {
      url = "github:fughilli/hitl-reserve/51c57f6fc54d84dd0b0aa02582e472c7ce06a3a3";
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
        appModules =
          if isX86
          then [ (import ./nix/hitl-sdr.nix { hitlSrc = hitl-reserve; }) ./observability/alloy.nix ]
          else [ (import ./nix/hitl-app.nix { hitlSrc = hitl-reserve; }) ./observability/alloy.nix ];
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
