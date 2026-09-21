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
  # reservation's env. Scoped to daemonUser via Match so it can't loosen the host's
  # normal auth. (nix-darwin writes /etc via environment.etc.)
  environment.etc."ssh/sshd_config.d/60-hitl.conf".text = ''
    Match User ${daemonUser}
      AuthorizedKeysFile ${stateDir}/authorized_keys
      PermitUserEnvironment yes
      # No agent/X11/port-forward for a reservation login; it's a hardware session.
      AllowAgentForwarding no
      X11Forwarding no
  '';

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
