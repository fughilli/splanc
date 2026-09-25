# Mac mini iOS HITL bench — a nix-darwin module (Phase D).
#
# This is the macOS counterpart to the Linux rig modules (hitl-app.nix /
# hitl-sdr.nix / hitl-phone-daemon.nix). It is deliberately ADDITIVE: a Mac mini
# is a multi-tenant, hand-managed host, so this module adds a launchd daemon, a
# scoped SSH user, and the iOS toolbox WITHOUT reprovisioning the machine. It is
# imported into a `darwinConfigurations.<mac>` in flake.nix and applied with
# `darwin-rebuild switch` ON THE MAC (it can't be built or evaluated from the
# Linux container — no darwin stdenv / nix-darwin module set here).
#
# The daemon runs `hitl-reserved --runner darwin` (the macOS backend added in
# hitl-reserve PR #7): no container, each reservation is a scoped SSH grant into
# the shared `hitl` user, with the unit's env forced per authorized_keys line.
# From that session the client drives the real iPhone (devicectl/usbmux, via
# tools/ios_build_server.py), the Simulator (simctl), and each C6 (esptool over
# /dev/cu.usbmodem*) — all host-native.
#
# Usage in flake.nix (see the handoff notes in reserve/README.md):
#   darwinConfigurations.mac-mini = darwin.lib.darwinSystem {
#     system = "aarch64-darwin";
#     modules = [ (import ./nix/hitl-darwin.nix { hitlSrc = hitl-reserve; }) ];
#   };
#
# Manual, one-time, ON THE MAC (not managed here — hardware/Apple-account state):
#   * Install the Xcode Command Line Tools (xcodebuild/simctl/devicectl/usbmux)
#     and accept the license; sign into Xcode for a device-provisioning profile.
#   * Fill the PLACEHOLDER iPhone UDID + C6 serial ports in reserve/catalog-mac.json.
#   * `tailscale up` and authorize the node (the daemon advertises on the tailnet).
{ hitlSrc }:
{ config, pkgs, lib, ... }:

let
  # The reservation daemon + CLI, built from the pinned hitl-reserve source (same
  # derivation the Linux rigs use — it carries the darwin runner). Kept in lockstep
  # with the @hitl_reserve git_override in //MODULE.bazel + the input in flake.nix.
  hitl = pkgs.callPackage ./packages.nix { src = hitlSrc; };

  # The shared user each reservation SSHes into (the darwin runner scopes access by
  # rewriting this user's authorized_keys per reservation). NOT an admin user.
  daemonUser = "hitl";

  # Writable scratch: the runner writes <stateDir>/authorized_keys (the managed key
  # file sshd reads for daemonUser) + <stateDir>/res/<id>/ per reservation.
  stateDir = "/var/lib/hitl";

  # The iOS catalog (two units: ios-phone + ios-sim, each with its own C6).
  catalog = ../reserve/catalog-mac.json;

  # Tailnet name holders reach this Mac by (also the reservation Endpoint host).
  # Override per-host if the tailnet name differs from the hostname.
  macHost = config.networking.hostName or "mac-mini";
in
{
  #### The reservation daemon (launchd) ######################################
  # Runs the darwin backend on :8087 (the fleet-wide reservation port). KeepAlive
  # restarts it on crash; RunAtLoad starts it at boot. Logs to /var/log so a
  # reservation failure is greppable without the container log plumbing the Linux
  # rigs use.
  launchd.daemons.hitl-reserved = {
    serviceConfig = {
      ProgramArguments = [
        "${hitl}/bin/hitl-reserved"
        "--catalog"
        "${catalog}"
        "--runner"
        "darwin"
        "--host"
        macHost
        "--ssh-user"
        daemonUser
        "--state-dir"
        stateDir
        "--darwin-ssh-port"
        "22"
        "--addr"
        ":8087"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      # Run as root so it can rewrite the managed authorized_keys (owned by root,
      # read by sshd) and read the state dir; it never execs the reservation
      # payload itself — that runs as daemonUser via the client's SSH session.
      UserName = "root";
      StandardOutPath = "/var/log/hitl-reserved.log";
      StandardErrorPath = "/var/log/hitl-reserved.err.log";
      EnvironmentVariables = {
        # devicectl/simctl/esptool live here once the toolbox + Xcode CLT are set up.
        PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/run/current-system/sw/bin";
      };
    };
  };

  #### sshd: scope the reservation user #######################################
  # A drop-in (macOS Ventura+ `Include /etc/ssh/sshd_config.d/*` is on by default)
  # that points sshd at the runner's managed key file for daemonUser and enables
  # the per-key `environment="K=V"` options the darwin runner uses to inject each
  # reservation's env. (nix-darwin writes /etc via environment.etc.)
  #
  # PermitUserEnvironment MUST be global, NOT inside the Match block: sshd rejects
  # that directive within a Match and then fails to parse the WHOLE config, so
  # every connection is dropped before the banner (locks the host out of ssh).
  # It's the one directive here that can't be scoped. On a dedicated bench Mac the
  # global loosening is acceptable — it's exactly what lets the runner inject each
  # reservation's env (authorized_keys `environment=`) and the hitl user's signing
  # vars (~/.ssh/environment). Everything that CAN be scoped stays in the Match.
  environment.etc."ssh/sshd_config.d/60-hitl.conf".text = ''
    PermitUserEnvironment yes
    Match User ${daemonUser}
      AuthorizedKeysFile ${stateDir}/authorized_keys
      # No agent/X11/port-forward for a reservation login; it's a hardware session.
      AllowAgentForwarding no
      X11Forwarding no
  '';

  #### iOS code-signing secret seam (headless device builds) ##################
  # A device build (tools/ios_build_server.py `device-build`) must codesign the
  # Capacitor .app, which needs an Apple Development identity in a keychain the
  # non-GUI reservation session can read — the login keychain is locked outside the
  # user's Aqua session, so it's unreachable here. We DON'T bake the user's login
  # password: instead the operator mints a DEDICATED signing keychain holding only
  # the dev cert, with its own throwaway password (see reserve/README.md), and the
  # build unlocks it from three env vars:
  #   HITL_SIGN_KEYCHAIN       path to the dedicated keychain (shared, hitl-readable)
  #   HITL_SIGN_KEYCHAIN_PASS  that keychain's own password (the only stored secret)
  #   HITL_SIGN_TEAM           optional DEVELOPMENT_TEAM for automatic signing
  #
  # For a PAID team, headless provisioning-profile creation needs an App Store
  # Connect API key instead of an interactive Apple ID. ios_build_server passes it
  # to xcodebuild -allowProvisioningUpdates when these three are also set:
  #   HITL_ASC_KEY_PATH        path to the AuthKey_<KEYID>.p8 (secret; shared path)
  #   HITL_ASC_KEY_ID          the 10-char key id (== the .p8 filename suffix)
  #   HITL_ASC_ISSUER_ID       the ASC issuer UUID (not secret)
  #
  # These are SECRETS, so they are NOT in catalog-mac.json (in-repo). They ride the
  # sshd `PermitUserEnvironment yes` seam above: put them in the daemon user's
  # host-managed, root-owned, non-repo env file — read on EVERY reservation login,
  # which is right since the signing keychain is host-level, not per-reservation:
  #
  #   /Users/${daemonUser}/.ssh/environment   (mode 0600, owned by ${daemonUser})
  #     HITL_SIGN_KEYCHAIN=${stateDir}/hitl-signing.keychain-db
  #     HITL_SIGN_KEYCHAIN_PASS=<the dedicated keychain's password>
  #     HITL_SIGN_TEAM=<10-char Apple team id>
  #
  # Copy the minted keychain to a path the `hitl` build user can read (its home is
  # locked to the user's Aqua login), e.g. ${stateDir}/hitl-signing.keychain-db
  # owned by ${daemonUser}. ios_build_server unlocks + search-lists it per build; a
  # local GUI dev run leaves all three unset and uses the interactive login keychain.

  #### The scoped reservation user ############################################
  # A non-admin login user. On macOS, nix-darwin can declare the user but a fresh
  # account still needs `sysadminctl`/dscl to fully materialize on first switch —
  # see reserve/README.md. UID in the standing-services range; no password (key-only
  # via the managed authorized_keys).
  users.users.${daemonUser} = {
    uid = 555;
    home = "/Users/${daemonUser}";
    shell = pkgs.bashInteractive;
    description = "HITL reservation session user (key-scoped per reservation)";
  };

  #### The reservation toolbox ################################################
  # Available to the daemon + each reservation login. Xcode itself + its CLT are
  # NOT nix-managed (Apple licensing / device provisioning) — installed manually;
  # here we provide the cross-cutting tools the harness + ios_build_server need.
  environment.systemPackages = with pkgs; [
    hitl # the `hitl` CLI, for local debugging on the Mac
    esptool # flash/monitor each C6 host-native
    python3 # the phone-HITL harness + tools/ios_build_server.py
    nodejs
    pnpm # build the web bundle the app wraps (Capacitor)
    cocoapods # iOS pod install for the Capacitor app
    libimobiledevice # idevice_id/idevicediagnostics — device id + sleep (screen off) over usbmux
    tailscale
    git
    jq
  ];

  #### Tailnet ################################################################
  services.tailscale.enable = true;

  # nix-darwin housekeeping: this module is imported into a darwinSystem, so it
  # only sets the HITL-specific state above and leaves the rest of the Mac alone.
  system.stateVersion = lib.mkDefault 5;
}
