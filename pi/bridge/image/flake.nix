{
  # Splanc bridge — a ready-to-flash Raspberry Pi SD image
  # (pi/bridge/README.md, "The SD image"; users: docs/pi-bridge.md).
  #
  # A NixOS appliance that boots straight into `splanc-agent bridge` (the cloud
  # agent's LAN bridge) with its pairing code on HDMI and on a Waveshare 1.3" OLED
  # HAT. Nobody logs in: WiFi, the device name and the Wi-Fi country come from
  # files the Splanc Bridge Flasher (pi/bridge/flasher) writes onto the card's
  # FAT boot partition, and the agent bundle updates itself.
  #
  #   nix build ./pi/bridge/image#image-pi5     # -> result/sd-image/*.img
  #   nix build ./pi/bridge/image#image-pi4     # (also: image-pi3, image-zero2w)
  #   nix build ./pi/bridge/image#checks.aarch64-linux.vm   # QEMU smoke test
  #
  # Released by .github/workflows/pi-bridge-image.yml on `pi-bridge-v*` tags.
  #
  # Pins: sbc-deploy at the same commit as //MODULE.bazel's git_override, which
  # pins nixpkgs (nixos-25.05) + nvmd/nixos-raspberrypi exactly as
  # pi/provisioning/nix and td-deploy do — so kernels/firmware built for those
  # images (and pushed to the fugstudio Cachix) are reused here. This flake does
  # NOT use mkSbcSystem: that wires in sbc-deploy's live-deploy SSH key
  # (asserted non-empty) and tailscale, and this appliance has neither. It takes
  # the board modules + sbc-base (mDNS, NetworkManager, lean firmware) and
  # assembles the system itself.
  description = "Splanc bridge — Raspberry Pi SD image (splanc-agent bridge + HDMI/OLED screens)";

  inputs.sbc-deploy.url = "github:fughilli/sbc-deploy/23c03bdcefa0cd4b90ea1ec611456984d91a389a?dir=nix";

  nixConfig = {
    extra-substituters = [
      "https://fugstudio.cachix.org"
      "https://nixos-raspberrypi.cachix.org"
    ];
    extra-trusted-public-keys = [
      "fugstudio.cachix.org-1:aMsAK2MbgNI3DjPERtXcAP0SBu65/8PkzAXHRr/68pc="
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
  };

  outputs = { self, sbc-deploy, ... }:
    let
      inherit (sbc-deploy.inputs) nixpkgs nixos-raspberrypi;
      lib = nixpkgs.lib;
      system = "aarch64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # Board key (asset name: splanc-bridge-<key>-<ver>.img.zst) -> nixos-raspberrypi board.
      boards = {
        pi5 = "raspberry-pi-5";
        pi4 = "raspberry-pi-4";
        pi3 = "raspberry-pi-3";
        zero2w = "raspberry-pi-02";
      };

      rev = self.shortRev or self.dirtyShortRev or "unknown";

      bridgeModules = [
        ./nix/bridge.nix
        ./nix/flash-config.nix
        ./nix/improv.nix
        ./nix/lean.nix
        ./nix/system-update.nix
        { splancBridge.imageRev = rev; }
      ];

      mkBridge = key: board:
        nixos-raspberrypi.lib.nixosSystem {
          specialArgs = { inherit nixos-raspberrypi; };
          modules = [
            nixos-raspberrypi.nixosModules.${board}.base
            nixos-raspberrypi.nixosModules.sd-image
            sbc-deploy.nixosModules.sbc-base
            sbc-deploy.nixosModules.spi
            ./nix/rpi.nix
            ./nix/system-update-rpi.nix
            { splancBridge.board = key; }
          ] ++ bridgeModules;
        };

      systems = lib.mapAttrs mkBridge boards;
      bridgePkgs = pkgs.callPackage ./nix/packages.nix { };
    in
    {
      nixosConfigurations = lib.mapAttrs' (k: v: lib.nameValuePair "splanc-bridge-${k}" v) systems;

      packages.${system} =
        lib.mapAttrs' (k: v: lib.nameValuePair "image-${k}" v.config.system.build.sdImage) systems
        // lib.mapAttrs' (k: v: lib.nameValuePair "toplevel-${k}" v.config.system.build.toplevel) systems
        // {
          inherit (bridgePkgs) agentBundle pyEnv splancPy fonts lgpio luma-core luma-oled;
          default = systems.pi5.config.system.build.sdImage;
        };

      # A generic-aarch64 QEMU VM with the same appliance modules (no Pi kernel or
      # firmware): boots, applies a flash-time boot config, runs the bridge against
      # a stub bundle, and self-updates from a local latest.json. See nix/vm-test.nix.
      checks.${system} = {
        vm = import ./nix/vm-test.nix { inherit pkgs bridgeModules; };
        # Full-system OTA: signed delta update A -> B, a rejected unsigned /
        # wrong-key release, and a B that fails its health check rolling back.
        vm-ota = import ./nix/vm-test-ota.nix { inherit pkgs bridgeModules; };
      };
    };
}
