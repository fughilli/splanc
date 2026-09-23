# Trusted substituter: the self-hosted Attic nix cache (tailnet node `attic`,
# tag:attic). Baked into every rig so on-rig nix operations — and, crucially, a
# deploy's `nix copy --substitute-on-destination` (sbc-deploy #23) — pull the
# expensive closure paths (the from-source linux_rpi-bcm2712/bcm2711 kernels above
# all) straight from the cache over the tailnet instead of receiving them over the
# deployer's uplink or rebuilding them. Pull is anonymous (public cache); the
# tag:attic ACL is the access boundary. The matching build-time substituter for the
# DEPLOYER lives in flake.nix `nixConfig` (honored via --accept-flake-config, #22).
#
# Cache coordinates are also in //pi/hitl/BUILD.bazel (_attic_cache/_attic_endpoint)
# and tools/attic-cache/. Keep the three in sync if the node/key ever changes.
{ lib, ... }:
{
  nix.settings = {
    extra-substituters = [ "http://attic.tail6b8ad3.ts.net:8080/splanc" ];
    extra-trusted-public-keys = [ "splanc:MWmTqIgwyOOGTh2wazhPPnVAsIIAV9pEXqhhorIWdvw=" ];
    # Don't let a down/unreachable cache stall a build: fall back to the upstreams
    # quickly instead of hanging on the tailnet endpoint.
    connect-timeout = lib.mkDefault 5;
    fallback = lib.mkDefault true;
  };
}
