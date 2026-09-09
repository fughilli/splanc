# The HITL Go binaries, built with nix from the hitl-reserve module source
# (github.com/fughilli/hitl-reserve — the generalized reservation system, pinned as
# a `flake = false` input in flake.nix and threaded in as `src`). Stdlib-only, so
# vendorHash = null. One derivation with both:
#   bin/hitl-reserved  — the reservation daemon
#   bin/hitl           — the client CLI
{ buildGoModule, lib, src }:
buildGoModule {
  pname = "hitl-reserve";
  version = "0.1.0";
  inherit src;
  vendorHash = null;
  subPackages = [ "cmd/hitl-reserved" "cmd/hitl" ];
  meta = {
    description = "HITL reservation daemon (hitl-reserved) + client CLI (hitl)";
    mainProgram = "hitl";
  };
}
