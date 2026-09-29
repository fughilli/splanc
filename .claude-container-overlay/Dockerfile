# claude-container overlay — appended to the base image Dockerfile by the
# launcher. The build runs as root; the container then runs as a non-root user
# the entrypoint creates at start, mapped to the host UID/GID (named `claude`).
# See .claude/skills/container-overlay.
#
# Port mappings live in overlay.json (migrated 2026-07-09 from the legacy
# single-file overlay form; the `# claude-container:port` comments that used to
# sit at the bottom of this file are now overlay.json `ports` entries).

# Nix with flakes — required by M4 (pi/provisioning): the image_sd / deploy_live
# Bazel targets and generating pi/provisioning/nix/flake.lock all shell out to
# `nix`, which is absent from the base image.
#
# The install itself is NOT here: it ships with the `bazel-polyglot-nix` skill as
# skills/bazel-polyglot-nix/overlay.Dockerfile, which the launcher prepends to
# this file (see `claude-container --skills-fragments`). Do not re-add it here —
# a second Determinate install duplicates a multi-minute layer over an existing
# /nix. Per-package additions go in the repo's flake.nix.

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

# Presubmit tooling (FUG-63): prek — a single-binary, drop-in reimplementation
# of pre-commit that reads the same .pre-commit-config.yaml. It is the enforced
# lint gate: ../startup.sh runs `prek install` per container so every `git
# commit` an agent makes runs the repo's hooks and fails loudly in-container
# (agents commit early and often, and the orchestrator only pushes committed
# work — so a green commit means the lints passed). CI runs the same `prek` on
# the same config, so local and CI verdicts never diverge.
#
# Pinned so the container, CI, and the human setup-precommit.sh all agree.
# python3-pip/venv are kept because prek provisions its Python-language hooks
# (black, isort, flake8) through them.
RUN apt-get update -qq && apt-get install -y -qq python3-pip python3-venv && \
    python3 -m pip install --break-system-packages 'prek==0.4.12'

# 2026-07-29: mark /workspace safe for git. The bind mount is owned by the host
# uid, which can differ from the runtime user's, tripping git's dubious-ownership
# check. Must be --system (/etc/gitconfig): --global at build time would write
# /root/.gitconfig, and the runtime `claude` user (created at container start)
# would never see it.
RUN git config --system --add safe.directory /workspace

# 2026-08-02: Tailscale — the HITL rigs (pi/hitl) accept tailnet peers only, so
# `hitl reserve|flash|monitor` and //pi/hitl/harness:e2e are unreachable from a
# container that isn't on the tailnet. issuefleet workers run in this container,
# which is what makes it load-bearing rather than a convenience.
#
# Installed here, STARTED per container by ../startup.sh — a daemon can't live
# in an image layer. The join also needs NET_ADMIN + /dev/net/tun, declared in
# overlay.json (claude-container >= 1.7.0).
RUN curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
        -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
        -o /etc/apt/sources.list.d/tailscale.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/tailscale /var/run/tailscale

# 2026-08-12: sigrok-cli libsigrokdecode4 sigrok-firmware-fx2lafw (recorded by apt-install)
RUN apt-get update && apt-get install -y --no-install-recommends \
        sigrok-cli \
        libsigrokdecode4 \
        sigrok-firmware-fx2lafw \
    && rm -rf /var/lib/apt/lists/*

# 2026-08-19: bake prek's hook environments into the image.
#
# ../startup.sh used to run `prek install --prepare-hooks` on every container
# start, which cold-builds every hook toolchain: venvs for black/isort/flake8,
# node envs for prettier/markdownlint, a rustup toolchain to compile
# nixpkgs-fmt, the buildifier binary. Measured at ~40s of *blocking* startup,
# paid EVERY launch — the launcher runs `docker run --rm`, so each session gets
# a fresh /home/claude and prek's cache (default $HOME/.cache/prek) is gone with
# it. Only /workspace and /claude are bind-mounted; nothing else survives.
#
# So build that cache once here, at a path outside $HOME that lives in the image
# layer, and point PREK_HOME at it. `prek install --prepare-hooks` in startup.sh
# then finds every environment already prepared (measured 0.07s).
#
# pre-commit-config.yaml next to this Dockerfile is a byte-identical copy of the
# repo's .pre-commit-config.yaml, kept in sync by the prek-overlay-config-copy
# hook. The copy is what makes the bake correct AND self-invalidating: the
# overlay directory is the docker build context and the launcher hashes its
# files into the image tag, so editing the root config changes the tag and
# rebuilds this layer. (The root file can't be COPYed directly — /workspace is
# mounted at run time, not build time.)
#
# Seeded as root, consumed by the runtime `claude` user, so the same treatment
# as /nix above: go+rwX, plus the cache's git clones marked safe.directory
# --system (they are root-owned, which otherwise trips dubious-ownership).
# Drift is not fatal: prek rebuilds only the hooks whose repo/rev moved (~2s for
# one hook) and writes them into this same cache as the runtime user.
#
# The rustup toolchain (520MB) is dropped after the build — nixpkgs-fmt is
# already compiled into its hook env by then, and rustup is only needed again if
# that hook's rev moves, in which case prek re-fetches it. Same RUN as the
# install, or the union filesystem would keep the bytes anyway. Net image
# growth: ~200MB.
ENV PREK_HOME=/opt/prek-cache
COPY pre-commit-config.yaml /opt/prek-seed/.pre-commit-config.yaml
RUN git init -q /opt/prek-seed \
    && git config --system --add safe.directory /opt/prek-seed \
    && prek install-hooks -C /opt/prek-seed \
    && rm -rf "$PREK_HOME/tools/rustup" "$PREK_HOME/cache" "$PREK_HOME/prek.log" \
    && chmod -R go+rwX "$PREK_HOME" \
    && git config --system --add safe.directory '/opt/prek-cache/*'
