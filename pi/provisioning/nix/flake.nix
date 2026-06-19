{
  # LED Mapper — Raspberry Pi NixOS provisioning flake.
  #
  # This flake defines the NixOS system that runs on the Pi in the field:
  #   * the LED pattern driver (M1, owns SPI)            -> systemd unit led-driver
  #   * the FastAPI/uvicorn web server (M2)              -> systemd unit led-server
  #   * the built web app served as static files (M5-M8)
  #
  # It also produces an SD-card installer image (via the nvmd/nixos-raspberrypi
  # flake) so a fresh Pi can be flashed and field-deployed, and supports
  # in-place upgrades via `nixos-rebuild switch --target-host`.
  #
  # All inputs are PINNED. See ../README.md "Pinned versions" and the repo
  # docs/decisions.md. To update a pin, bump the ref/rev here and regenerate
  # flake.lock (`nix flake update` on a machine with nix), then record the
  # change in the decision log.
  #
  # NOTE: This flake has NOT been evaluated/built in the authoring environment
  # because `nix` is not installed here (see README "Unverified" section).

  description = "LED Mapper — Raspberry Pi NixOS image and live-deploy config";

  inputs = {
    # Pin nixpkgs to a release branch. nixos-raspberrypi tracks its own nixpkgs
    # internally; we follow it to keep a single coherent package set and avoid
    # divergent kernel/firmware. Override here only if you need newer userspace.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    # Raspberry Pi board support (kernel, firmware, device tree, SD image).
    # Pinned to a tagged release of nvmd/nixos-raspberrypi.
    # Tag v1.20260517.0 == commit 06c6e3513e1ee64b651913193fc6ac38aa4963f5.
    nixos-raspberrypi.url = "github:nvmd/nixos-raspberrypi/v1.20260517.0";

    # Keep nixos-raspberrypi's nixpkgs and ours aligned. (If you intentionally
    # want a different userspace, drop this `follows` and accept two package
    # sets.)
    nixos-raspberrypi.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-raspberrypi, ... }@inputs:
    let
      # ----------------------------------------------------------------------
      # Tunables. The Bazel wrappers can override `board` and `hostName` via
      # `--override-input`-style args or by editing here. Defaults target a Pi 5.
      # ----------------------------------------------------------------------
      board = "raspberry-pi-5"; # or "raspberry-pi-4"
      hostName = "ledmapper";

      # The system that actually runs on the Pi (aarch64-linux).
      mkLedMapperSystem = { extraModules ? [ ] }:
        nixos-raspberrypi.lib.nixosSystem {
          specialArgs = inputs;
          modules = [
            # Board hardware support from the nixos-raspberrypi flake.
            ({ ... }: {
              imports = [
                nixos-raspberrypi.nixosModules.${board}.base
                nixos-raspberrypi.nixosModules.${board}.display-vc4
                # Provides config.system.build.sdImage (a directly-bootable
                # SD image of THIS system — not the live installer; that is
                # what nixos-raspberrypi.lib.nixosInstaller would add instead).
                nixos-raspberrypi.nixosModules.sd-image
              ];
            })

            # Our application + system config.
            ./modules/ledmapper.nix
            ./modules/ssh-deploy.nix
            ./modules/networking.nix
            ./modules/spi.nix

            {
              networking.hostName = hostName;
              # Turn on our application module (led-driver + led-server units).
              # Without this the ledmapper.nix config block (lib.mkIf cfg.enable)
              # is inert and the image ships no LED Mapper services.
              services.ledMapper.enable = true;
              # Pin the state version so upgrades are well-defined and the
              # eval-time "stateVersion not set" warning goes away.
              system.stateVersion = "25.05";
            }
          ] ++ extraModules;
        };
    in
    {
      # The runtime system closure. Used by `deploy_live` (nixos-rebuild
      # --target-host reads `.#nixosConfigurations.<host>.config.system.build.toplevel`).
      nixosConfigurations.${hostName} = mkLedMapperSystem { };

      # SD-card image. `image_sd` builds this and dd's it to a device.
      # nixos-raspberrypi exposes the image under the system build attrs.
      images.sdImage =
        self.nixosConfigurations.${hostName}.config.system.build.sdImage;

      # Convenience alias matching the upstream flake's naming, so
      # `nix build .#installerImage` also works.
      packages.aarch64-linux.installerImage =
        self.nixosConfigurations.${hostName}.config.system.build.sdImage;
    };
}
