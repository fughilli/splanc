{
  # LED Mapper — Raspberry Pi provisioning, as an sbc-deploy consumer.
  #
  # This used to be a bespoke nixos-raspberrypi flake with hand-written modules
  # and shell wrappers. That tooling was extracted into the reusable sbc-deploy
  # framework (github.com/fughilli/sbc-deploy) and this now just consumes it:
  # `mkSbcProject` builds the base + full images and the deploy config, and
  # `services.sbcApps` (from sbc-deploy) models the two long-lived Pi processes.
  #
  # The application packages are still PLACEHOLDERS (see apps.nix) — M1/M2 are
  # Bazel-built polyglot apps (Python + the Rust solver) not yet packaged for
  # Nix; only the `package` needs swapping in once they are.
  #
  # Built via `//pi/provisioning:ledmapper.*`. The sbc-deploy version is pinned
  # by flake.lock here (Nix side) in parallel with the git_override in
  # //MODULE.bazel (Bazel side) — keep the two revs in sync. To co-develop
  # sbc-deploy locally: `--override-input sbc-deploy path:/abs/path/to/nix`.

  description = "LED Mapper — Raspberry Pi image + live-deploy (sbc-deploy consumer)";

  inputs.sbc-deploy.url = "github:fughilli/sbc-deploy?dir=nix";

  outputs = { self, sbc-deploy, ... }:
    sbc-deploy.lib.mkSbcProject {
      hostName = "ledmapper";
      board = "raspberry-pi-5"; # or "raspberry-pi-4"
      appModules = [ ./apps.nix ./improv.nix ];
      # Baked into BOTH the base and full images: hardware SPI (SK9822/APA102)
      # for the driver. WiFi can be added here too (sbcDeploy.wifi.networks).
      systemModules = [ sbc-deploy.nixosModules.spi ];
    };
}
