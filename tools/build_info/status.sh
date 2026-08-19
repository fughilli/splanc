#!/usr/bin/env bash
#
# Bazel workspace status command (registered in //.bazelrc). Bazel runs this on
# every build, in the workspace root, OUTSIDE the action sandbox (so it has the
# real git checkout), and folds its `KEY value` lines into
# bazel-out/stable-status.txt. The `build_info_file` rule (//tools/build_info)
# reads those STABLE_* keys to stamp the git commit + dirty flag into a firmware
# header and the web app's build-info JSON.
#
# STABLE_* keys land in stable-status.txt, whose content changes only when the
# commit / dirty state changes — so stamped outputs (and their dependents) only
# rebuild on a real change, not on every build.
set -euo pipefail

commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
short=$(git rev-parse --short=8 HEAD 2>/dev/null || echo unknown)
# --porcelain is empty exactly when the working tree + index match HEAD.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  dirty=1
  dirty_json=true
else
  dirty=0
  dirty_json=false
fi

echo "STABLE_GIT_COMMIT ${commit}"
echo "STABLE_GIT_COMMIT_SHORT ${short}"
echo "STABLE_GIT_DIRTY ${dirty}"
echo "STABLE_GIT_DIRTY_JSON ${dirty_json}"
