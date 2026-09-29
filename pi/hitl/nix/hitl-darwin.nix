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
#     modules = [ (import ./nix/hitl-darwin.nix {
#       hitlSrc = hitl-reserve;
#       # attach a real iPhone -> stand up the launchd ios-build-server:
#       iosBuildUser = "kevin";                 # owns the checkout + Xcode sign-in
#       iosBuildWorkspace = "/Users/kevin/splanc-iosbench";  # DEDICATED, see below
#     }) ];
#   };
#
# The recurring test flow is RESERVATION-DRIVEN and hands-off: a container/CI runner
# reserves the `ios-phone` unit over the tailnet, the darwin runner grants a scoped
# SSH session, and the harness (shipped in) runs phone_e2e on the Mac — serving the
# app + driver WS the iPhone connects back to, driving the launchd ios-build-server
# on loopback, and running the journeys. No human runs bazel/build commands on the Mac.
#
# Genuinely one-time, ON THE MAC (hardware / Apple-account / iOS-security state that
# no service can automate):
#   * Install Xcode + Command Line Tools (xcodebuild/simctl/devicectl/usbmux), accept
#     the license; sign into Xcode once for device provisioning.
#   * A DEDICATED splanc checkout at iosBuildWorkspace with the Capacitor iOS project
#     generated (`cap add ios` — regenerated, gitignored) and the signing keychain set
#     up; drop the signing secrets in ${stateDir}/ios-build.env (see iosBuildEnvFile).
#     It MUST NOT be the operator's day-to-day checkout: the container's /workspace is
#     a bind-mount of that checkout, so agents' `git checkout` flip its branch live —
#     the build server would randomly build another agent's branch. Use a separate
#     clone pinned to a stable ref (this branch pre-merge, `main` after), kept only for
#     the bench. (The app CONTENT the iPhone loads is served from the tar the reserved
#     session ships, not this checkout's web/dist, so its web/dist staleness is moot —
#     this checkout supplies only the native iOS project + config + plugins + signing.)
#   * Plug in the iPhone, enable Developer Mode, keep it unlocked (Auto-Lock=Never),
#     and accept the one-time "trust this computer" + "allow local network" prompts.
#   * `tailscale up` and authorize the node (the daemon advertises on the tailnet).
# The catalog's iPhone UDID / C6 serial are the reserved unit's env markers; the C6
# serial PORT is discovered dynamically at flash time (pi/hitl/harness/serial_discovery.py),
# never hardcoded.
# iOS-build service parameters (all optional): a host that attaches a real iPhone
# sets `iosBuildUser` (the account that owns the repo checkout + Xcode sign-in, e.g.
# the operator's login) and `iosBuildWorkspace` (an absolute path to a splanc
# checkout on the Mac) to stand up the launchd `ios-build-server` below. Left null,
# the service isn't added (a Mac without an iPhone still deploys). Signing secrets
# are NOT passed here — they live in a root/-user-owned env file outside the nix
# store (see iosBuildEnvFile).
{ hitlSrc
, iosBuildUser ? null
, iosBuildWorkspace ? null
, iosBuildPort ? 8099
, iosDeveloperDir ? "/Applications/Xcode.app/Contents/Developer"
}:
{ config, pkgs, lib, ... }:

let
  # The reservation daemon + CLI, built from the pinned hitl-reserve source (same
  # derivation the Linux rigs use — it carries the darwin runner). Kept in lockstep
  # with the @hitl_reserve git_override in //MODULE.bazel + the input in flake.nix.
  hitl = pkgs.callPackage ./packages.nix { src = hitlSrc; };

  # Python for the reserved iOS session's harness. The container ships phone_e2e +
  # its data (web/dist, solver, firmware bundle, journeys) into the reservation and
  # runs it with THIS python3 (on the session PATH): its driver_server needs
  # `websockets`, and serial_discovery needs `pyserial` to enumerate the C6's port for
  # flashing (connect/config journeys). Everything else the iOS lane uses is stdlib.
  # (Real BLE runs on the phone via the Capacitor plugin, so no bleak is needed here.)
  pyEnv = pkgs.python3.withPackages (ps: with ps; [ websockets pyserial ]);

  # The iOS build/install/launch server (tools/ios_build_server.py) runs as a launchd
  # SERVICE, not a hand-started process — the reserved session drives it over
  # loopback (IOS_BUILD_SERVER=http://127.0.0.1:<port>) to cap-sync/build/sign/install/
  # launch the Capacitor app on the real iPhone. It runs as `iosBuildUser` (needs that
  # account's Xcode + the signing keychain) against `iosBuildWorkspace` (a splanc
  # checkout on the Mac). Only added when both are set.
  iosBuildEnabled = iosBuildUser != null && iosBuildWorkspace != null;
  # HERMETIC tool PATH for the build server: reference the nix tools by their absolute
  # store bin dirs (prepended) so `pnpm`/`node`/`pod`/`git`/`bazelisk`/`jq` always
  # resolve — never rely on /run/current-system/sw/bin being on the launchd env (it
  # wasn't: bootstrap hit `pnpm: command not found`). bazelisk is only needed here for
  # the one-time web-build (it reads .bazelversion and fetches the right bazel), so it
  # lives in this service PATH rather than systemPackages. Xcode's xcodebuild/devicectl/
  # xcrun/simctl come from /usr/bin (+ DEVELOPER_DIR), kept after the store paths.
  iosBuildTools = with pkgs; [ pyEnv nodejs pnpm cocoapods git bazelisk jq coreutils ];
  iosBuildPath =
    "${lib.makeBinPath iosBuildTools}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  # Signing + App Store Connect secrets for the build server, sourced at launch from a
  # file OUTSIDE the nix store (never world-readable): HITL_SIGN_KEYCHAIN,
  # HITL_SIGN_KEYCHAIN_PASS, HITL_SIGN_TEAM, and the HITL_ASC_* trio for a paid team.
  # It MUST live where the BUILD USER can read it — the build server runs as
  # ${toString iosBuildUser}, so a root:0600 file in the 0700-root state dir is
  # unreadable and the `. ios-build.env` sources nothing (seen live: the device build
  # then found "No Accounts"/no signing cert). Put it in the build user's own config:
  #   install -m600 /path/to/ios-build.env /Users/${toString iosBuildUser}/.config/hitl/ios-build.env
  # (owned by ${toString iosBuildUser}). The service no-ops if it's absent (a
  # simulator-only Mac). Alongside the keychain pass + ASC key that setup-ios-signing.sh
  # already writes under ~/.config/hitl.
  iosBuildEnvFile = "/Users/${toString iosBuildUser}/.config/hitl/ios-build.env";

  # The shared user each reservation SSHes into (the darwin runner scopes access by
  # rewriting this user's authorized_keys per reservation). NOT an admin user.
  daemonUser = "hitl";

  # Writable scratch: the runner writes <stateDir>/authorized_keys (the managed key
  # file sshd reads for daemonUser) + <stateDir>/res/<id>/ per reservation.
  stateDir = "/var/lib/hitl";

  # Token file for the periodic pipeline trigger (launchd job below). Holds a GitHub
  # PAT with actions:write on fughilli/splanc (a fine-grained PAT, or a classic
  # repo-scoped token). Placed OUT-OF-BAND (never in the world-readable nix store):
  #   sudo install -m600 -o root /path/to/token /var/lib/hitl/github-dispatch.token
  # The job no-ops if it's absent/empty, so a Mac without the token still deploys.
  dispatchTokenFile = "${stateDir}/github-dispatch.token";

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

  #### Periodic HITL pipeline trigger (launchd) ##############################
  # GitHub's own `schedule:` cron drops/heavily delays scheduled runs on this repo
  # (a well-known Actions limitation), so we drive the HITL monitor from this
  # always-on Mac instead: every 6h, POST a workflow_dispatch to hitl.yaml on main
  # (4 runs/day). Token from a root-only file outside the nix store (see
  # dispatchTokenFile); the job no-ops if it's missing so a token-less Mac still
  # deploys cleanly. Replaces the removed `schedule:` block in hitl.yaml.
  launchd.daemons.hitl-schedule-dispatch = {
    serviceConfig = {
      ProgramArguments = [
        "/bin/sh"
        "-c"
        ''
          tok=$(cat ${dispatchTokenFile} 2>/dev/null) || exit 0
          [ -n "$tok" ] || exit 0
          exec ${pkgs.curl}/bin/curl -sS -X POST \
            -H "Authorization: token $tok" \
            -H "Accept: application/vnd.github+json" \
            https://api.github.com/repos/fughilli/splanc/actions/workflows/hitl.yaml/dispatches \
            -d '{"ref":"main"}'
        ''
      ];
      # Every 6 hours (4x/day). RunAtLoad=false so a `darwin-rebuild switch` doesn't
      # fire an extra run; the first fires ~6h after load.
      StartInterval = 21600;
      RunAtLoad = false;
      UserName = "root";
      StandardOutPath = "/var/log/hitl-schedule-dispatch.log";
      StandardErrorPath = "/var/log/hitl-schedule-dispatch.err.log";
    };
  };

  #### iOS build/install/launch server (launchd) #############################
  # A flake-provided SERVICE (not a hand-started terminal process) so the
  # reservation-driven iOS journey run is hands-off: the reserved session drives it
  # over loopback to cap-sync → sign → device-build → install → launch the Capacitor
  # app on the real iPhone. Runs as the operator account (Xcode + signing keychain)
  # against a splanc checkout on the Mac; both are set by the host via iosBuildUser /
  # iosBuildWorkspace, else this service is omitted. Binds 127.0.0.1 only — the
  # reserved harness runs on THIS Mac, so it reaches the server on loopback (no LAN
  # exposure of the build endpoint).
  #
  # IT MUST BE A LaunchAgent, NOT a system LaunchDaemon: code-signing (xcodebuild
  # automatic signing / -allowProvisioningUpdates) and devicectl only work from the
  # operator's LOGIN (Aqua) GUI session. Verified live on the Mac: the exact
  # device-build command signs in an interactive session ("BUILD SUCCEEDED") but a
  # system LaunchDaemon (Background session) fails "No signing certificate … with a
  # private key" for the same command/keychain/env — the Background session can't
  # resolve the developer's signing identity. A launchd.user.agent runs in the logged-in
  # user's gui domain, so signing + devicectl behave as they do interactively. (The
  # agent is loaded by `activate-user` run AS the user; the reservation-driven deploy
  # runs `<sys>/activate` as root and `<sys>/activate-user` as the operator.) Requires
  # the operator to stay logged in — fine for a dedicated always-on bench Mac.
  #
  # KeepAlive gates on PathState of the server script, so if iosBuildWorkspace is on an
  # external volume that mounts late/detaches, launchd starts/stops the agent with the
  # volume instead of crash-looping. (An internal workspace path avoids that entirely.)
  launchd.user.agents.ios-build-server = lib.mkIf iosBuildEnabled {
    serviceConfig = {
      ProgramArguments = [
        "/bin/sh"
        "-c"
        ''
          set -a
          [ -f ${iosBuildEnvFile} ] && . ${iosBuildEnvFile}
          set +a
          export DEVELOPER_DIR=${iosDeveloperDir}
          exec ${pyEnv}/bin/python3 ${iosBuildWorkspace}/tools/ios_build_server.py \
            --host 127.0.0.1 --port ${toString iosBuildPort} \
            --workspace ${iosBuildWorkspace}
        ''
      ];
      RunAtLoad = true;
      KeepAlive = {
        # Run only while the workspace (hence its external volume) is present.
        PathState."${iosBuildWorkspace}/tools/ios_build_server.py" = true;
      };
      # No UserName: a LaunchAgent already runs as the logged-in user (iosBuildUser).
      # Logs go to that user's own Library/Logs (writable by them; /var/log is not).
      StandardOutPath = "/Users/${toString iosBuildUser}/Library/Logs/ios-build-server.log";
      StandardErrorPath = "/Users/${toString iosBuildUser}/Library/Logs/ios-build-server.err.log";
      EnvironmentVariables = {
        # HERMETIC: nix tools (node/pnpm/cocoapods/git/bazelisk/jq) by absolute store
        # path first, so a missing /run/current-system/sw/bin on the launchd env can't
        # cause `command not found`; then Homebrew + /usr/bin for xcodebuild/devicectl.
        PATH = iosBuildPath;
        HOME = "/Users/${toString iosBuildUser}";
        LANG = "en_US.UTF-8";
        # Silence the Capacitor CLI first-run telemetry prompt in the non-TTY service.
        CAP_DISABLE_TELEMETRY = "true";
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
      # macOS sshd reads AuthorizedKeysFile AS THE TARGET USER, but the darwin runner
      # writes the managed key file root:0600 inside a 0700 root state dir — so the
      # hitl user cannot open its OWN authorized_keys (verified on the live Mac:
      # "Could not open user 'hitl' authorized keys '…': Permission denied"), and every
      # reserved-session ssh was rejected. Read it via a command that runs AS ROOT
      # instead (AuthorizedKeysCommandUser root), which needs no world-readable perms
      # and isn't subject to the AuthorizedKeysFile StrictModes/uid read. This also
      # overrides nix-darwin's global AuthorizedKeysCommand (a per-user file we don't
      # populate) for this user. /bin/cat is root-owned + not writable, as required.
      AuthorizedKeysCommand /bin/cat ${stateDir}/authorized_keys
      AuthorizedKeysCommandUser root
      # Kept as documentation / a fallback for an sshd that reads keys as root; on this
      # macOS it fails the uid read and the command above is what actually authenticates.
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
  # A non-admin login user. UID in the standing-services range; no usable password
  # (key-only via the managed authorized_keys). Declared here for reference; the
  # ACTUAL macOS account is created by the activation script below — nix-darwin
  # declares users.users but does NOT create a fresh account unless it's in
  # users.knownUsers, and even then it doesn't set up the account's OpenDirectory
  # auth authority + home the way `sysadminctl` does. On a fresh Mac this record is
  # simply absent (`dscl . -read /Users/hitl` -> eDSRecordNotFound), and the reserved
  # session's pubkey SSH can never authenticate a user that doesn't exist. (Verified
  # on the live Mac: the daemon/HTTP works, but every reserved-session ssh was denied
  # because this account had never materialized.)
  users.users.${daemonUser} = {
    uid = 555;
    home = "/Users/${daemonUser}";
    shell = pkgs.bashInteractive;
    description = "HITL reservation session user (key-scoped per reservation)";
  };

  # Materialize the reservation account on `darwin-rebuild switch`, idempotently and
  # WITHOUT BLOCKING. We create the record with plain `dscl`, NOT `sysadminctl
  # -addUser`: on a FileVault Mac, sysadminctl's secure-token/FDE enrollment blocks
  # on a GUI authorization dialog when run non-interactively (from the launchd/
  # activation context) — it hung the first switch until the operator clicked an
  # invisible prompt, and would hang a headless/CI activation forever. (macOS ships
  # no `timeout` to bound it, so we avoid the blocking call entirely.) `dscl` writes
  # the local directory record directly with no FDE dance, and `dscl -passwd` (run as
  # root, no old password needed) gives it a proper auth record so pubkey SSH works
  # (the random password is never used — password login stays disabled). Guarded on
  # UniqueID so a partial record isn't mistaken for a complete one. Every step is
  # `|| true` so activation can never be aborted by it.
  system.activationScripts.postActivation.text = lib.mkAfter ''
    if ! /usr/bin/dscl . -read /Users/${daemonUser} UniqueID >/dev/null 2>&1; then
      echo "[hitl-darwin] creating reservation user '${daemonUser}' (uid 555, key-only, dscl)" >&2
      /usr/bin/dscl . -create /Users/${daemonUser} || true
      /usr/bin/dscl . -create /Users/${daemonUser} RealName "HITL reservation session user" || true
      /usr/bin/dscl . -create /Users/${daemonUser} UniqueID 555 || true
      /usr/bin/dscl . -create /Users/${daemonUser} PrimaryGroupID 20 || true
      # Stable system shell (NOT a nix-store bash whose path would be GC'd out from
      # under the account, breaking the ssh `sh -c` the reservation runs).
      /usr/bin/dscl . -create /Users/${daemonUser} UserShell /bin/bash || true
      /usr/bin/dscl . -create /Users/${daemonUser} NFSHomeDirectory /Users/${daemonUser} || true
      /usr/bin/dscl . -create /Users/${daemonUser} IsHidden 1 || true
    fi
    # Ensure a usable auth record even for a PRE-EXISTING PARTIAL account — e.g. one a
    # hung sysadminctl left with UID/home/shell but NO AuthenticationAuthority (seen on
    # the live Mac). macOS rejects EVERY login for such an account, pubkey included, so
    # the reserved-session ssh fails even though the user "exists". Setting a random
    # (unused) password materializes ShadowHashData + AuthenticationAuthority; only when
    # it's missing, so it doesn't churn the record on every switch. Password login stays
    # disabled in practice (we always authenticate by the runner-managed key).
    if ! /usr/bin/dscl . -read /Users/${daemonUser} AuthenticationAuthority >/dev/null 2>&1; then
      echo "[hitl-darwin] materializing auth record for '${daemonUser}' (ShadowHash)" >&2
      # `dscl -passwd` alone populates ShadowHashData (a password) but does NOT create
      # the AuthenticationAuthority POINTER, and macOS then authenticates nothing for
      # the account — pubkey ssh included (verified on the live Mac: a working account
      # has `;ShadowHash;HASHLIST:…`, ours had no key at all). Create the pointer first,
      # then set the password so the hashes live under it.
      /usr/bin/dscl . -create /Users/${daemonUser} AuthenticationAuthority ";ShadowHash;" || true
      /usr/bin/dscl . -passwd /Users/${daemonUser} "$(/usr/bin/head -c 32 /dev/urandom | /usr/bin/base64)" || true
    fi
    /bin/mkdir -p /Users/${daemonUser}/.ssh
    /usr/sbin/chown -R ${daemonUser}:staff /Users/${daemonUser} 2>/dev/null || true
    /bin/chmod 700 /Users/${daemonUser} /Users/${daemonUser}/.ssh 2>/dev/null || true
    # macOS Remote Login (sshd) is gated by the `com.apple.access_ssh` SACL group,
    # which nests admin — so a NON-admin service account like this one is rejected at
    # login even with a valid key + auth record (verified on the live Mac: reserved
    # ssh failed purely because the account wasn't in this group). Add it explicitly
    # so reservations can ssh in without making the account an admin. Idempotent.
    /usr/sbin/dseditgroup -o edit -a ${daemonUser} -t user com.apple.access_ssh 2>/dev/null || true
  '';

  #### The reservation toolbox ################################################
  # Available to the daemon + each reservation login. Xcode itself + its CLT are
  # NOT nix-managed (Apple licensing / device provisioning) — installed manually;
  # here we provide the cross-cutting tools the harness + ios_build_server need.
  environment.systemPackages = with pkgs; [
    hitl # the `hitl` CLI, for local debugging on the Mac
    esptool # flash/monitor each C6 host-native
    pyEnv # python3 (+ websockets) for the reserved session's phone_e2e harness
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
