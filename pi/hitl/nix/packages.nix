# The HITL Go binaries, built with nix. Stdlib-only, so vendorHash = null.
# One derivation with both:
#   bin/hitl-managerd  — the Pi-side reservation daemon
#   bin/hitl           — the agent-facing CLI
{ buildGoModule, lib }:
buildGoModule {
  pname = "hitl";
  version = "0.1.0";
  # The flake root is pi/hitl (has go.mod); this file is pi/hitl/nix/.
  src = lib.cleanSource ../.;
  vendorHash = null;
  subPackages = [ "cmd/hitl-managerd" "cmd/hitl" ];
  meta = {
    description = "HITL rig reservation daemon (hitl-managerd) + agent CLI (hitl)";
    mainProgram = "hitl";
  };
}
