"""Where the demos keep their local data, run straight from the checkout or by `bazel run`.

Run as `python3 tools/vive/demos/app.py`, the demos keep mounts/, sessions/ and the OSC
dry-run log next to their sources. `bazel run` starts them inside the (read-only) runfiles
tree, so there they use the checkout Bazel names in BUILD_WORKSPACE_DIRECTORY, and relative
paths on the command line (--map pixielamp.csv) are taken from where `bazel run` was
typed (BUILD_WORKING_DIRECTORY).
"""

import os

PACKAGE = os.path.join("tools", "vive", "demos")


def data_dir(here):
    """The demos' data directory: the source directory in the checkout."""
    workspace = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    return os.path.join(workspace, PACKAGE) if workspace else here


def user_path(path):
    """A path from the command line, relative to where the user typed it."""
    cwd = os.environ.get("BUILD_WORKING_DIRECTORY")
    if path and cwd and not os.path.isabs(path):
        return os.path.join(cwd, path)
    return path
