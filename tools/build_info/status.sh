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
# "Dirty" means the committed *sources* were modified — a change to a TRACKED
# file. --untracked-files=no ignores untracked files on purpose: a build /
# CI step routinely drops artifacts in the workspace (e.g. the site build
# stages _site/ and downloads _flashbundle/ before this runs), and those must
# NOT make an otherwise-pristine checkout report dirty (FUG-126 review).
if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
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
