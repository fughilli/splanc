# claude-container overlay — appended to the base image Dockerfile by the
# launcher. The build runs as root; the container then runs as a non-root user
# the entrypoint creates at start, mapped to the host UID/GID (named `claude`).
# See .claude/skills/container-overlay.
#
# Port mappings live in overlay.json (migrated 2026-07-09 from the legacy
# single-file overlay form; the `# claude-container:port` comments that used to
# sit at the bottom of this file are now overlay.json `ports` entries).

# 2026-06-19: Nix with flakes — required by M4 (pi/provisioning). The image_sd /
# deploy_live Bazel targets and generating pi/provisioning/nix/flake.lock all
# shell out to `nix`, which is absent from the base image. This is the skill's
# "project uses Nix" case: install once here; per-package additions go in the
# repo's flake.nix, not this overlay.
#
# Uses the Determinate Systems nix-installer: the upstream installer's
# single-user path shells out to `sudo` (absent from the base image), so it
# fails even when the build itself is already running as root. Determinate's
# installer needs no sudo and exposes `--init none` to skip the systemd daemon
# setup that has no place in a container.
#
# build-users-group is cleared so builds run as the calling user (no nixbld
# group is created), and the sandbox is disabled since the container can't set
# up build-sandbox user namespaces without privilege.
RUN curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
        -o /tmp/nix-installer.sh \
    && sh /tmp/nix-installer.sh install linux \
        --init none \
        --no-confirm \
        --extra-conf "experimental-features = nix-command flakes" \
        --extra-conf "build-users-group =" \
        --extra-conf "sandbox = false" \
    && rm /tmp/nix-installer.sh
ENV PATH=/nix/var/nix/profiles/default/bin:$PATH

# The base image has no `claude` user at build time: the entrypoint fabricates
# it at container start, mapping the *host* UID/GID in (so its uid/gid — and
# even its group name — vary per host). The Determinate installer leaves /nix
# owned by root, so daemon-less Nix as that runtime user fails trying to chmod
# the root-owned `/nix/var/nix/profiles/per-user` ("Operation not permitted"),
# which blocks every `nix` invocation (flake.lock generation, image_sd,
# deploy_live).
# We can't chown to a name/uid that doesn't exist yet and isn't known at build
# time, so instead make the single-user store group/other-writable: any runtime
# uid can then manage profiles, the DB, and gcroots without a daemon. Portable
# across hosts. (Store stays in /nix; the prebuilt paths and DB are preserved.)
#
# The per-user profile/gcroots dirs need extra care: Nix re-chmods them to 0755
# on *every* invocation and fails with EPERM when it doesn't own them — and
# go+rwX leaves them 0777, which guarantees that failed re-chmod. So delete them
# here; the runtime user recreates and owns them on its first `nix` call (the
# go+rwX parents above make that mkdir possible). Without this, a fresh container
# needs a manual `sudo chown $(whoami) /nix/var/nix/profiles/per-user` before any
# `nix` command works (the workaround used to verify M4 on 2026-06-19).
#
# BUT deleting per-user also severs the `default` profile: the installer makes
# /nix/var/nix/profiles/default a symlink INTO per-user/root/profile, so after
# the rm -rf the ENV PATH above points through a dangling link and no `nix` is
# callable at all (bit us 2026-07-13; repaired by hand that session). Resolve
# default to its store path FIRST and re-point it directly at the store —
# profile MUTATION by the runtime user was never supported here; PATH access
# to the pinned binaries is all `default` has to provide.
RUN PROFILE_STORE_PATH="$(readlink -f /nix/var/nix/profiles/default)" \
    && chmod -R go+rwX /nix \
    && rm -rf /nix/var/nix/profiles/per-user /nix/var/nix/gcroots/per-user \
    && ln -sfn "$PROFILE_STORE_PATH" /nix/var/nix/profiles/default

# openssh-client: ssh-keygen for the M4 deploy-key flow
# (pi/provisioning/scripts/manage_keys.sh). Not in the base image; install the
# client so `bazel run //pi/provisioning:keys` and image_sd's key bootstrap work
# without shelling out to a nix-provided one.
# sudo: give the runtime user passwordless root. The entrypoint always names the
# user it creates `claude`, and sudo resolves that name when invoked (at run
# time), so the drop-in is valid even though `claude` does not exist at build
# time. Portable: the rule keys on the name, not a host-specific uid.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'claude ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude

# Presubmit tooling (branch ci-presubmits): pip + pre-commit so the repo's
# hooks (.pre-commit-config.yaml) run locally in the container.
RUN apt-get update -qq && apt-get install -y -qq python3-pip python3-venv && \
    python3 -m pip install --break-system-packages pre-commit

# 2026-07-29: mark /workspace safe for git. The bind mount is owned by the host
# uid, which can differ from the runtime user's, tripping git's dubious-ownership
# check. Must be --system (/etc/gitconfig): --global at build time would write
# /root/.gitconfig, and the runtime `claude` user (created at container start)
# would never see it.
RUN git config --system --add safe.directory /workspace
