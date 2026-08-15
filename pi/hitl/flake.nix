{
  # HITL rig — Raspberry Pi image + live-deploy (sbc-deploy consumer) plus the
  # `hitl` agent CLI. See DESIGN.md.
  #
  # Built via `//pi/hitl:hitl.*` (image_sd / image_sd_base / deploy_live / ssh /
  # keys). The CLI is `packages.<system>.hitl` for agents to `nix run` / install.
  description = "HITL rig — Pi test bench + agent CLI (sbc-deploy consumer)";

  inputs = {
    sbc-deploy.url = "github:fughilli/sbc-deploy/cb70fcc832700c776a960d8f4303876acab0ac36?dir=nix";
    nixpkgs.follows = "sbc-deploy/nixpkgs";
  };

  outputs = { self, nixpkgs, sbc-deploy, ... }:
    let
      project = sbc-deploy.lib.mkSbcProject {
        hostName = "hitl-rig";
        board = "raspberry-pi-5";
        appModules = [ ./nix/hitl-app.nix ];
        # systemModules = [ sbc-deploy.nixosModules.spi ];  # if the DUT needs SPI
      };

      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems f;
    in
    project // {
      # The hitl CLI for agents (claude-container): `nix run …#hitl -- reserve`.
      packages = forAll (system:
        let hitl = nixpkgs.legacyPackages.${system}.callPackage ./nix/packages.nix { };
        in { inherit hitl; default = hitl; });
    };
}
