"""Install Playwright's Chromium (and, on CI, its system libraries).

    bazel run //tools/release_clips:install_browser [-- --with-deps]

--with-deps (the default when $CI is set) also installs the apt packages
headless Chromium needs; that step uses sudo, as GitHub's runners allow.
"""

import os
import subprocess
import sys


def main() -> int:
    with_deps = "--with-deps" in sys.argv[1:] or bool(os.environ.get("CI"))
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    cmd = [sys.executable, "-m", "playwright", "install", "chromium"]
    if with_deps:
        cmd.insert(4, "--with-deps")
    return subprocess.run(cmd, env=env).returncode


if __name__ == "__main__":
    sys.exit(main())
