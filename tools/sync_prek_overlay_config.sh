#!/usr/bin/env bash
#
# Keep .claude-container-overlay/pre-commit-config.yaml byte-identical to
# .pre-commit-config.yaml.
#
# The agent container bakes prek's hook environments into an image layer
# (.claude-container-overlay/Dockerfile) so container startup doesn't pay a ~40s
# cold toolchain build per launch. The bake needs the config at *docker build*
# time, when /workspace isn't mounted yet — hence the copy inside the overlay
# directory, which is the build context.
#
# The copy is also the cache-invalidation key: the launcher hashes the overlay's
# build inputs into the image tag, so updating this copy is what makes the next
# `claude-container` rebuild the baked cache against the new config. Let it drift
# and the container silently rebuilds the changed hooks at startup instead.
#
# Run by the prek-overlay-config-copy hook (and safe to run by hand). Behaves
# like the formatting hooks: rewrites the file and fails when it had to.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

SRC=.pre-commit-config.yaml
DST=.claude-container-overlay/pre-commit-config.yaml

if cmp -s "$SRC" "$DST"; then
    exit 0
fi

cp "$SRC" "$DST"
echo "Updated $DST from $SRC."
echo "Stage it: the container rebakes its prek hook cache on the next claude-container launch."
exit 1
