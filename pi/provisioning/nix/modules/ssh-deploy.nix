# SSH + deploy-key trust for passwordless first-boot deploys.
#
# The deploy flow owns a key pair (see ../scripts/manage_keys.sh and
# ../README.md "SSH key management"):
#   * PUBLIC half  -> baked into root's authorized_keys here, so the imaged Pi
#                     trusts the deploy key on first boot.
#   * PRIVATE half -> stays on the operator's machine (gitignored
#                     secrets/ dir or env), used by `deploy_live` for
#                     `nixos-rebuild switch --target-host`.
#
# The public key text is read at NIX EVAL time from a path. We resolve it in
# this order (first that exists wins):
#   1. The path in env var  LEDMAPPER_DEPLOY_PUBKEY_FILE
#   2. ../../secrets/deploy_key.pub  (gitignored; produced by manage_keys.sh)
#
# If neither exists, eval fails with a clear message rather than silently
# building an image nobody can log into.
#
# UNVERIFIED: not eval'd here (no nix). The builtins logic is straightforward
# but confirm the relative path resolves from the flake's location on a real
# build (the flake lives in nix/, secrets/ is two levels up at provisioning/).
{ config, lib, pkgs, ... }:

let
  envPath = builtins.getEnv "LEDMAPPER_DEPLOY_PUBKEY_FILE";
  # Relative to this module file: modules/ -> nix/ -> provisioning/secrets/
  defaultPath = ../../secrets/deploy_key.pub;

  pubkeyPath =
    if envPath != "" && builtins.pathExists (/. + envPath)
    then (/. + envPath)
    else defaultPath;

  pubkey =
    if builtins.pathExists pubkeyPath
    then lib.strings.trim (builtins.readFile pubkeyPath)
    else throw ''
      LED Mapper deploy public key not found.

      Looked at:
        $LEDMAPPER_DEPLOY_PUBKEY_FILE (= "${toString envPath}")
        ${toString defaultPath}

      Generate one with:
        pi/provisioning/scripts/manage_keys.sh init

      (Never commit the private key. See pi/provisioning/README.md.)
    '';
in
{
  services.openssh = {
    enable = true;
    settings = {
      # Key-only auth. The deploy key is the trust anchor.
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password"; # root login by key only (for nixos-rebuild)
    };
    openFirewall = true;
  };

  # Trust the deploy key for root (needed: nixos-rebuild switch --target-host
  # activates the new system as root over SSH).
  users.users.root.openssh.authorizedKeys.keys = [ pubkey ];

  # Ensure the activation toolchain is present on the target so remote
  # nixos-rebuild can build/switch (it shells in and runs these).
  environment.systemPackages = with pkgs; [ git rsync ];
  nix.settings.trusted-users = [ "root" ];
}
