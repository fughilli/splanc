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
    # sbc-deploy main @ f51b3f2 (#7 persistent hostname identity + #8 `update`
    # mode: board + capability-profile autodetect). Kept in lockstep with the
    # @sbc_deploy git_override in //MODULE.bazel.
    sbc-deploy.url = "github:fughilli/sbc-deploy/f51b3f2?dir=nix";
    nixpkgs.follows = "sbc-deploy/nixpkgs";

    # The generalized reservation system. Not a flake (plain Go module source);
    # buildGoModule consumes it in nix/packages.nix. Kept in lockstep with the
    # @hitl_reserve git_override in //MODULE.bazel — bump both together.
    hitl-reserve = {
      url = "github:fughilli/hitl-reserve/c6699e9003b54ea602b3df5166cf46a47b928663";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, sbc-deploy, hitl-reserve, ... }:
    let
      project = sbc-deploy.lib.mkSbcProject {
        hostName = "hitl-rig";
        board = "raspberry-pi-5";
        # observability/alloy.nix is opt-in but safe to always import: its
        # hitl-alloy service is gated on /var/lib/hitl/grafana.env existing
        # (ConditionPathExists), so a rig without Grafana creds just doesn't
        # start it. Seed the creds with `bazel run //pi/hitl:seed_grafana`.
        #
        # hitl-app.nix is a FUNCTION of the hitl-reserve source (so the app module
        # can build the daemon/CLI from it); apply it here to get the module value.
        appModules = [ (import ./nix/hitl-app.nix { hitlSrc = hitl-reserve; }) ./observability/alloy.nix ];
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
