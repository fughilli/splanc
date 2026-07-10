---
name: bazel-polyglot-nix
description: Set up or extend a Bazel (bzlmod) project — writing MODULE.bazel for a polyglot Python/JS/TS repo, combining Nix with Bazel (Determinate nix-installer in a container overlay + rules_nixpkgs registration), and hermetic Python with lockfile management via rules_uv or compile_pip_requirements. Use when asked to add Bazel to a repo, add a language/toolchain/dependency to an existing MODULE.bazel, wire Nix-built packages into a Bazel build, set up/regenerate a Python lockfile the Bazel way, or make Bazel's disk/repository cache persist across container restarts.
---

# Bazel for polyglot projects, with Nix and hermetic Python

Instructions for a future session with no memory of how this pattern was built.
The goal is a **bzlmod** Bazel project (no `WORKSPACE`) that builds multiple
languages under one dependency graph, pulls hermetic toolchains from the Bazel
Central Registry (BCR), optionally borrows packages from Nix, and drives every
dependency set from a checked-in lockfile.

Guiding principles, applied throughout:

- **One graph, many languages.** A single `MODULE.bazel` at the repo root
  declares every toolchain. Generated code (protobuf, schema bindings) becomes a
  build target both language halves depend on, so drift fails the build instead
  of shipping.
- **Hermetic, pinned, reproducible.** Toolchains and interpreters come from the
  registry, not the host. Every version is pinned; every transitive set is
  locked. The host needs only Bazel (via Bazelisk) — not a system Python/Node.
- **Nix stays out of the critical path.** `bazel build //...` must stay green on
  machines with no `nix` binary. Register Nix rules, but never force a Nix
  evaluation at fetch time unless a target actually needs it.

---

## 1. Repo skeleton

```
MODULE.bazel            # bzlmod: every toolchain + dependency extension
MODULE.bazel.lock       # committed; the resolved transitive module graph
BUILD.bazel             # root package; hosts the lockfile-regen target
.bazelversion           # exact Bazel version (read by Bazelisk)
.bazeliskrc             # Bazelisk config (cache location, etc.)
.bazelrc                # build/test/common flags
.bazelignore            # dirs Bazel must not descend into (node_modules, .venv)
requirements.in         # direct Python deps (human-edited)   ─┐ lockfile pair
requirements.lock       # fully resolved Python deps (generated)┘
package.json            # JS/TS deps + pinned tool versions
pnpm-lock.yaml          # resolved JS deps
pnpm-workspace.yaml     # which dirs are pnpm workspace members
```

Pin Bazel itself with Bazelisk so every machine and CI runs the same binary:

```
# .bazelversion
7.7.1
```

```
# .bazeliskrc — cache Bazel binaries inside the project tree so they survive
# container rebuilds / fresh homes (path is relative to the workspace root).
BAZELISK_HOME=.bazelisk
```

Always invoke `bazelisk` (or a `bazel` that is Bazelisk), never a system
`bazel`, so the pin is honored.

---

## 2. Writing MODULE.bazel for a polyglot project

`MODULE.bazel` has three kinds of statements, in this order:

1. `module(...)` — this repo's own identity.
2. `bazel_dep(...)` — a rule set / library pulled from the BCR, pinned by version.
3. `use_extension(...)` + the extension's tag calls + `use_repo(...)` — how a
   rule set materializes toolchains and external repos into your graph.

### Module identity

```starlark
module(
    name = "my_project",
    version = "0.0.0",
    compatibility_level = 1,
)
```

### Core language rules (pin every one)

```starlark
# Python
bazel_dep(name = "rules_python", version = "2.0.3")

# JS / TS via the Aspect rules (pnpm-native). aspect_bazel_lib is a shared
# dependency of the Aspect rule sets.
bazel_dep(name = "aspect_rules_js", version = "3.2.2")
bazel_dep(name = "aspect_rules_ts", version = "3.8.11")
bazel_dep(name = "aspect_bazel_lib", version = "2.22.5")

# Packaging (tarballs/debs/images to ship build outputs)
bazel_dep(name = "rules_pkg", version = "1.2.0")
```

Find current versions on the Bazel Central Registry (registry.bazel.build). Bump
versions **intentionally**, not opportunistically, and keep a short decision log
noting *why* each pin was chosen and the date — update the log and `MODULE.bazel`
together.

### Python toolchain + pip (see §4 for lockfile mechanics)

```starlark
PYTHON_VERSION = "3.11"

python = use_extension("@rules_python//python/extensions:python.bzl", "python")
python.toolchain(
    is_default = True,
    python_version = PYTHON_VERSION,
)

pip = use_extension("@rules_python//python/extensions:pip.bzl", "pip")
pip.parse(
    hub_name = "pypi",
    python_version = PYTHON_VERSION,
    requirements_lock = "//:requirements.lock",
)
use_repo(pip, "pypi")
```

`rules_python` downloads a hermetic interpreter, so **no system Python is
required** to build. In BUILD files, third-party imports resolve through the hub
repo: `@pypi//numpy`, `@pypi//fastapi`, etc.

### JS / TS toolchain over a pnpm workspace

```starlark
npm = use_extension("@aspect_rules_js//npm:extensions.bzl", "npm")
npm.npm_translate_lock(
    name = "npm",
    pnpm_lock = "//:pnpm-lock.yaml",
    # Cross-check that node_modules dirs are gitignored / bazelignored so Bazel
    # doesn't accidentally read a host-installed tree.
    verify_node_modules_ignored = "//:.bazelignore",
)
use_repo(npm, "npm")

# TypeScript compiler version, taken from package.json so Bazel and a
# command-line `tsc`/`pnpm` always agree on one version.
rules_ts_ext = use_extension(
    "@aspect_rules_ts//ts:extensions.bzl",
    "ext",
    dev_dependency = True,
)
rules_ts_ext.deps(
    ts_version_from = "//:package.json",
)
use_repo(rules_ts_ext, "npm_typescript")
```

Root `BUILD.bazel` then links the workspace's npm deps and exposes a shared
tsconfig:

```starlark
load("@aspect_rules_ts//ts:defs.bzl", "ts_config")
load("@npm//:defs.bzl", "npm_link_all_packages")

package(default_visibility = ["//visibility:public"])

npm_link_all_packages(name = "node_modules")

ts_config(
    name = "tsconfig_base",
    src = "tsconfig.base.json",
)
```

### The polyglot payoff: one generated source of truth

The reason to co-locate languages in one graph is shared generated code. Define
the schema/IDL once, generate both a Python module and a TS module from it with a
`genrule`/codegen rule, and add a test target that regenerates and diffs against
the committed output. If the bindings drift, the build goes red — neither half
can ship a stale wire format.

### `.bazelrc` essentials

```
# bzlmod is the source of truth; no WORKSPACE.
common --enable_bzlmod
common --registry=https://bcr.bazel.build

# Hermetic action env so the on-disk cache is correct across machines.
build --incompatible_strict_action_env

# Persist caches in the project tree (dot-prefixed, gitignored) so they survive
# container restarts that wipe ~/.cache. Both are content-addressable, so they
# are safe even on a case-insensitive (macOS) bind mount.
build  --disk_cache=.bazel-disk-cache        # action outputs
common --repository_cache=.bazel-repo-cache  # downloaded external archives

test --test_output=errors
```

Gitignore the generated dirs: `.bazel-disk-cache/`, `.bazel-repo-cache/`,
`.bazelisk/`, `bazel-*` symlinks, `node_modules/`, `.venv/`.

### Persistent disk cache inside a container

By default Bazel keeps everything — output base, disk cache, downloaded external
archives — under `~/.cache/bazel` (i.e. `$HOME` on the container's **root
filesystem**). In an ephemeral container that root fs is wiped on every
restart/rebuild, so every fresh container re-downloads all external archives and
recompiles from scratch. The one directory that *does* survive is the
**workspace bind mount** (`/workspace`), because it lives on the host. So the
trick is: point Bazel's caches at dot-prefixed, gitignored dirs **inside the
workspace tree**, and they persist across container restarts for free.

Three caches to relocate, each a separate flag (already shown above, plus the
Bazelisk one from §1):

| Cache | Flag / config | Holds | Why relocate |
| --- | --- | --- | --- |
| Disk cache | `build --disk_cache=.bazel-disk-cache` | action outputs (compiled objects, etc.) | skips recompilation |
| Repository cache | `common --repository_cache=.bazel-repo-cache` | downloaded external archives (rule sets, wheels, npm tarballs) | skips the slow, flaky network re-fetch — the real first-build bottleneck |
| Bazelisk cache | `.bazeliskrc` → `BAZELISK_HOME=.bazelisk` | the pinned Bazel binaries themselves | avoids re-downloading Bazel on each fresh home |

```
# .bazelrc
build  --disk_cache=.bazel-disk-cache        # action outputs; survives restarts
common --repository_cache=.bazel-repo-cache  # external archives; survives restarts
```

Paths are relative to the workspace root (the directory containing the
`.bazelrc`), so they resolve to `/workspace/.bazel-disk-cache` etc. regardless of
what `$HOME` is inside the container. Gitignore all three.

**Two things to get right:**

- **Relocate the *caches*, not the *output base*.** Both caches above are
  content-addressable (hash-named files), so they are safe even on a
  **case-insensitive** bind mount (typical on macOS). Do **not** move the full
  output base (`--output_base` / `--output_user_root`) into the workspace: its
  external-repo tree — notably the Python interpreter/repo — contains files
  differing only by case, which corrupts on a case-insensitive filesystem. Leave
  the output base on the container's own fs (rebuilding it is cheap once the two
  caches are warm) and persist only the caches.
- **The caches only grow.** Neither cache auto-evicts. Cap the disk cache with
  `build --disk_cache=.bazel-disk-cache` plus a periodic prune, or size-bound it
  in newer Bazel with `--experimental_disk_cache_gc_max_size` (e.g.
  `--experimental_disk_cache_gc_max_size=10G`). If disk pressure appears, it is
  always safe to `rm -rf .bazel-disk-cache .bazel-repo-cache` — Bazel just
  repopulates them on the next build.

If instead of a bind mount you have a **named Docker volume** mounted at
`~/.cache/bazel`, you can skip the in-tree relocation and let Bazel use its
defaults — the volume persists on its own. The in-tree approach is preferred here
because it needs no launcher/volume config, travels with the repo, and keeps each
branch/worktree's cache next to its sources.

**Gotcha — aarch64 SIGILL on startup:** some Bazel/bundled-JDK combos emit SVE
instructions that crash the JVM with `SIGILL` on certain aarch64 hosts (a symptom
is a zombie `[java] <defunct>` server the launcher keeps failing to kill). If you
hit it, add `startup --host_jvm_args=-XX:UseSVE=0` to `.bazelrc`; it's harmless
on hosts without SVE, so it can be set unconditionally.

---

## 3. Nix + Bazel together

Two independent concerns — don't conflate them:

- **(a) Install the `nix` binary in the environment** so tools/targets that shell
  out to `nix` work. For a `claude-container` this belongs in the container
  overlay Dockerfile (below), *not* in the repo.
- **(b) Register `rules_nixpkgs`** in `MODULE.bazel` so Bazel *can* import
  Nix-built derivations as Bazel targets — but keep it registration-only until
  something actually needs it.

### (a) Determinate nix-installer in a container overlay layer

In a container, the stock nix-installer's single-user path shells out to `sudo`
(often absent) and its multi-user path wants systemd. The **Determinate Systems**
installer needs no `sudo` and offers `--init none` to skip daemon setup — ideal
for an image build that already runs as root. Add this to
`.claude-container-overlay/Dockerfile` (see the `container-overlay` skill for the
overlay mechanics):

```dockerfile
# Nix with flakes. Determinate's installer needs no sudo and --init none skips
# the systemd daemon that has no place in a container. build-users-group is
# cleared so builds run as the calling user (no nixbld group); sandbox is off
# because the container can't set up build-sandbox user namespaces unprivileged.
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
```

**Runtime-user gotcha (single-user store, dynamic UID).** If the container's
build runs as root but the *runtime* user is created at start with a
host-mapped UID (as `claude-container` does), daemon-less Nix run by that user
fails trying to `chmod` root-owned `/nix/var/nix/profiles/per-user`
(`Operation not permitted`), which blocks every `nix` call. You can't `chown` to
a UID that doesn't exist at build time, so make the store writable by any UID and
delete the per-user dirs (Nix recreates+owns them on first use):

```dockerfile
# Any runtime uid can then manage profiles/DB/gcroots without a daemon. Nix
# re-chmods per-user dirs to 0755 every call and EPERMs if it doesn't own them,
# so delete them here; the runtime user recreates and owns them on first `nix`.
RUN chmod -R go+rwX /nix \
    && rm -rf /nix/var/nix/profiles/per-user /nix/var/nix/gcroots/per-user
```

Install Nix **once** at the bottom of the overlay and never edit that block
(editing invalidates the Docker layer cache). Per-package additions belong in a
`flake.nix` checked into the repo, not the overlay.

### (b) Register rules_nixpkgs without breaking `bazel build //...`

```starlark
# rules_nixpkgs lets Bazel import Nix-built packages as Bazel targets. Register
# the module (pinned) so the option exists — but DO NOT declare a `nix_repo` /
# `nixpkgs_package` here. Declaring one makes Bazel evaluate Nix at fetch time,
# which FAILS on machines without `nix` and breaks the build for everyone.
bazel_dep(name = "rules_nixpkgs_core", version = "0.13.0")
```

This is the key discipline: **registration-only**. Targets that only need to run
Nix (e.g. building an SD image, deploying a NixOS config) should be plain
`sh_binary` wrappers that shell out to the `nix` CLI and carry their
`flake.nix`/`flake.lock` as `data` — they don't need `rules_nixpkgs` to *run*, so
the build graph stays evaluable everywhere. Only when you genuinely want a
Nix-built library *inside* the Bazel graph do you add `nix_repo` +
`nixpkgs_package` extension calls — and at that point accept that those specific
targets require `nix` present.

Keep the repo's Nix inputs pinned in `flake.nix` and locked in a committed
`flake.lock`; regenerate with `nix flake update` on a machine that has Nix, and
record the bump in the decision log alongside the other pins.

---

## 4. Hermetic Python + lockfile management

`rules_python` gives the hermetic interpreter. Dependencies flow from a
human-edited direct-deps file to a fully-resolved lockfile that Bazel consumes
via `pip.parse(requirements_lock = ...)`. Two mechanisms to generate that
lockfile — pick one:

### Option A (recommended): rules_uv

[`rules_uv`](https://github.com/theoremlp/rules_uv) drives Astral's **uv** (a
fast, hermetic resolver) to produce and check the lockfile as Bazel targets — no
system `uv` or `pip` needed.

`MODULE.bazel`:

```starlark
bazel_dep(name = "rules_uv", version = "0.86.0")   # check BCR for current
bazel_dep(name = "rules_python", version = "2.0.3")
```

`BUILD.bazel` at the repo root:

```starlark
load("@rules_uv//uv:pip.bzl", "pip_compile")

# Regenerate the lockfile:  bazel run //:generate_requirements_lock
pip_compile(
    name = "generate_requirements_lock",
    requirements_in = "//:requirements.in",
    requirements_txt = "//:requirements.lock",
)
```

Workflow:

1. Edit `requirements.in` (direct deps only, e.g. `numpy`, `fastapi`,
   `pydantic>=2.6`).
2. `bazel run //:generate_requirements_lock` — uv resolves the full transitive
   set into `requirements.lock`.
3. Commit both files. `pip.parse` in `MODULE.bazel` already points at
   `//:requirements.lock`, so the build picks it up.

Add a CI check that the lockfile is current (rules_uv exposes a
`*.update`/check-style target, or run the generate target and `git diff
--exit-code`). uv also provides fast full-lock formats; start with the
`requirements.in → requirements.lock` pair above since `pip.parse` consumes it
directly.

### Option B: compile_pip_requirements (rules_python built-in)

No extra `bazel_dep`; uses `pip-tools` under the hood. Good when you don't want
uv in the toolchain.

`BUILD.bazel`:

```starlark
load("@rules_python//python:pip.bzl", "compile_pip_requirements")

# Regenerate:  bazel run //:requirements.update
# Verify (CI): bazel test //:requirements_test   (auto-created by the macro)
compile_pip_requirements(
    name = "requirements",
    src = "requirements.in",
    requirements_txt = "requirements.lock",
)
```

Same edit → regenerate → commit loop; the regen target is
`//:requirements.update` and the macro also generates a test that fails if the
lockfile is stale.

### Either way

- **Single root lockfile drives the whole repo.** One `requirements.in` /
  `requirements.lock` pair at the root, consumed by one `pip.parse`. Sub-packages
  reference deps as `@pypi//<pkg>`; they don't get their own lockfiles.
- **Platform-only deps:** a dependency that exists only on the deploy target
  (e.g. a Pi-only `spidev` provided by the system image) should be **imported
  lazily** in code and kept **out** of the lockfile, so the interpreter stays
  hermetic and the test suite runs anywhere.
- **`uvicorn[standard]`-style extras** go in `requirements.in` verbatim; the
  resolver expands them in the lock.

---

## 5. Checklist when extending an existing setup

- Adding a Python dep → edit `requirements.in`, run the regen target, commit
  `requirements.lock`. Never hand-edit the lockfile.
- Adding a JS dep → `pnpm add` in the right workspace, commit `pnpm-lock.yaml`.
- Bumping a rule set → change the `bazel_dep` version, run
  `bazel mod deps`/a build to refresh `MODULE.bazel.lock`, commit it, update the
  decision log.
- Wiring in a Nix-built package for the first time → add `nix_repo` +
  `nixpkgs_package` extension calls, and note that those targets now require
  `nix` on the builder.
- New machine/CI → needs only Bazelisk; the hermetic toolchains and the caches
  (`.bazel-repo-cache`, `.bazel-disk-cache`) do the rest.
