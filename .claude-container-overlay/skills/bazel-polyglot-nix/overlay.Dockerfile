# Nix (flakes) for Bazel repos that pull toolchains through rules_nixpkgs.
#
# This fragment is concatenated into the effective overlay Dockerfile by the
# claude-container launcher and runs AS ROOT at image build time. It is shared
# by every project that accepts this skill, so editing it prompts each of them
# to confirm a rebuild at their next launch -- write it once, leave it alone.
# Per-project or per-package additions belong in the project's own
# .claude-container-overlay/Dockerfile or its flake.nix, never here.

# Determinate Systems nix-installer: the upstream installer's single-user path
# shells out to `sudo` (absent from the base image), so it fails even when the
# build itself is already running as root. Determinate's installer needs no sudo
# and exposes `--init none` to skip the systemd daemon setup that has no place
# in a container.
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
# it at container start, mapping the *host* UID/GID in (so its uid/gid -- and
# even its group name -- vary per host). The Determinate installer leaves /nix
# owned by root, so daemon-less Nix as that runtime user fails trying to chmod
# the root-owned /nix/var/nix/profiles/per-user ("Operation not permitted"),
# which blocks every `nix` invocation.
# We can't chown to a name/uid that doesn't exist yet and isn't known at build
# time, so instead make the single-user store group/other-writable: any runtime
# uid can then manage profiles, the DB, and gcroots without a daemon. Portable
# across hosts. (Store stays in /nix; the prebuilt paths and DB are preserved.)
#
# The per-user profile/gcroots dirs need extra care: Nix re-chmods them to 0755
# on *every* invocation and fails with EPERM when it doesn't own them -- and
# go+rwX leaves them 0777, which guarantees that failed re-chmod. So delete them
# here; the runtime user recreates and owns them on its first `nix` call (the
# go+rwX parents above make that mkdir possible).
#
# BUT deleting per-user also severs the `default` profile: the installer makes
# /nix/var/nix/profiles/default a symlink INTO per-user/root/profile, so after
# the rm -rf the ENV PATH above points through a dangling link and no `nix` is
# callable at all. Resolve default to its store path FIRST and re-point it
# directly at the store -- profile MUTATION by the runtime user was never
# supported here; PATH access to the pinned binaries is all `default` provides.
RUN PROFILE_STORE_PATH="$(readlink -f /nix/var/nix/profiles/default)" \
    && chmod -R go+rwX /nix \
    && rm -rf /nix/var/nix/profiles/per-user /nix/var/nix/gcroots/per-user \
    && ln -sfn "$PROFILE_STORE_PATH" /nix/var/nix/profiles/default

# Belt-and-braces for the Bazel path: rules_nixpkgs resolves `nix-build` with
# repository_ctx.which() from a subprocess environment that is not guaranteed to
# carry the ENV PATH above (a login shell, a re-exec, or a strict-action-env
# flag can drop it). Symlink the Determinate Nix binaries into /usr/local/bin --
# always on PATH, on the image fs -- so every shell and every Bazel repo-rule
# subprocess finds them. The version calls double as a build-time assertion: if
# the profile relink above ever regresses, the IMAGE BUILD fails here instead of
# surfacing days later as `nix: command not found`.
RUN NIXBIN="$(find /nix/store -maxdepth 2 -type d -name bin -path '*-determinate-nix-*' | head -1)" \
    && test -n "$NIXBIN" \
    && for b in "$NIXBIN"/*; do ln -sf "$b" /usr/local/bin/"$(basename "$b")"; done \
    && nix --version \
    && nix-build --version

# Mark /workspace safe for git. The bind mount is owned by the host uid, which
# can differ from the runtime user's, tripping git's dubious-ownership check.
# Must be --system (/etc/gitconfig): --global at build time would write
# /root/.gitconfig, and the runtime `claude` user (created at container start)
# would never see it.
RUN git config --system --add safe.directory /workspace
