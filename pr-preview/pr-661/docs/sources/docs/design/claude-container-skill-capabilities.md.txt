# Phase-aware skill capabilities for `claude-container`

> Status: **proposal**, written 2026-09-22. Audience: an agent/engineer
> implementing this in the `claude-container` launcher. This document is
> self-contained — it does not assume you have seen the conversation that
> produced it. It proposes (a) making Claude Code *skills* able to carry
> everything a container capability needs — image layers, runtime privileges,
> boot hooks, and **host services** — so a capability can be adopted with one
> command instead of being hand-wired into each project's overlay; and (b) a
> first-class **host-services** primitive: launcher-supervised host-side processes
> the container reaches by name, mirroring the in-container `services` that
> `overlay.json` already supports.

## 1. Problem

`claude-container` lets a workspace propose **skills** under
`<workspace>/.claude-container-overlay/skills/<name>/SKILL.md`. The launcher
deploys them into the live skills directory at start, and the user can promote a
skill user-wide with `claude-container --skills-adopt <name>`, after which every
project is offered it.

Skills today can only carry **instructions and inert files**. That is enough for
advice ("here is how to triage a flaky test") but not for a *capability* that
needs to touch the container's construction. Two real capabilities expose the
gap:

- **`tailnet`** — put the container on the user's Tailscale tailnet so the agent
  can reach tailnet-only hosts. Making it work requires **four** separate pieces,
  only one of which a skill can carry:
  1. an image layer that installs the `tailscale` client
     (`.claude-container-overlay/Dockerfile`);
  2. runtime docker flags — `NET_ADMIN`, `/dev/net/tun`, and an `env`
     passthrough for `TS_AUTHKEY` (`.claude-container-overlay/overlay.json`);
  3. a per-container boot hook that starts `tailscaled` and runs `tailscale up`
     (`.claude-container-overlay/startup.sh`);
  4. an ephemeral auth key supplied from the host environment.

- **`host-deploy`** — run host-only build/deploy commands (a host builder VM, an
  SSH deploy that must originate from the host, host `bazel`/`nix`) from inside
  the container, via a file-mailbox bridge over the shared repo mount. It needs a
  **process running on the host, outside the container** (`hostdeploy.py`), which
  today the user must start by hand — the skill cannot bundle or launch it.

So a skill can *describe* these capabilities and even ship the scripts as inert
files, but a human or agent must re-inject the pieces into the container's
Dockerfile, `overlay.json`, `startup.sh`, and the host, **per project**.
"Adopt system-wide" spreads the instructions everywhere; the plumbing is still
hand-wired every time.

## 2. Root cause: skills exist at the wrong lifecycle phase

A container capability spans four phases, each with a different actor and a
different moment:

| Phase | When | Actor | Configured today in |
| --- | --- | --- | --- |
| **Image** | image build | root | `.claude-container-overlay/Dockerfile` |
| **Runtime privileges** | `docker create`/`run` | launcher | `overlay.json` (`capabilities`, `devices`, `env`, `sysctls`, `ports`, `services`) |
| **In-container boot** | container start | mapped user (+ sudo) | `.claude-container-overlay/startup.sh` |
| **Host services** | on the host, alongside the container | *the user, manually* | *nothing* |

**Skills only exist in a fifth, later phase: agent-runtime.** They are deployed
into the live skills directory *after* the image is built and the container is
already running — they are read-time files for the agent. Therefore a skill
**structurally cannot**:

- contribute a Dockerfile layer (the image is already built),
- request `NET_ADMIN` or a device node (the container is already created),
- register a boot hook (`startup.sh` already ran),
- start a host service (skills have no host-side surface at all).

That phase mismatch is the whole bug. The fix is a single architectural shift:

> **The launcher must resolve the active skill set *before* it builds the image
> and creates the container, and let each skill contribute at every phase.**

Everything in this proposal follows from that one change.

## 3. Design overview

Introduce a **skill manifest** (`skill.json`, or an equivalent frontmatter
block in `SKILL.md`) that a skill uses to declare contributions to each phase.
The launcher's startup becomes a resolution pipeline that folds every active
skill's contributions into the container it builds:

```
resolve active skills for this project
  → collect per-phase contributions from each skill manifest
  → build image      (base overlay Dockerfile + ordered skill Dockerfile fragments)
  → compute run flags (base overlay.json ⊎ union of skill runtime blocks)
  → docker create/run
  → run boot hooks   (ordered: project startup.sh + skill startup drop-ins)
  → start host services (launcher-supervised; container discovers them by name)
  → launch the agent (skills also deployed into the live skills dir, as today)
```

The **host-services** step is a first-class primitive, not a per-skill
convenience — see §5.4 and §6. It is the mirror of the in-container `services`
that `overlay.json` already supports (a container process reachable from the host
by name); a host service is a *host* process reachable from the *container* by
name, with a launcher-managed lifecycle and a single host-exec policy.

A skill that declares no phase contributions behaves exactly as it does today
(pure instructions) — this is a strict superset, fully backward compatible.

## 4. The skill manifest

`<skill>/skill.json` (all sections optional):

```jsonc
{
  "name": "tailnet",
  "version": "1",

  // Phase: IMAGE — fragments appended to the image build, each in its own layer.
  "image": {
    "dockerfile": "Dockerfile.snippet"   // path relative to the skill dir
  },

  // Phase: RUNTIME PRIVILEGES — merged into the effective overlay.json.
  "runtime": {
    "capabilities": ["NET_ADMIN"],
    "devices": ["/dev/net/tun"],
    "env": ["TS_AUTHKEY"],               // forwarded BY NAME (value from host env)
    "sysctls": {},
    "services": {}                       // { name: port } — in-container services
  },

  // Phase: IN-CONTAINER BOOT — ordered startup.d drop-ins, run as the mapped user.
  "container": {
    "startup": "tailnet-up.sh",          // path relative to the skill dir
    "order": 50                          // lower runs earlier; default 50
  },

  // Phase: HOST SERVICES — named host-side processes the launcher supervises and
  // the container discovers by name. See §5.4 for the primitive.
  "hostServices": {
    "hostdeploy": {
      "start": "python3 hostdeploy.py",  // argv run on the HOST
      "cwd": "$REPO_ROOT",               // default; so a repo-mount bridge is visible
      "transport": "mount",              // mount | tcp  (how the container reaches it)
      "healthcheck": ".hostdeploy/alive",// file freshness (mount) or a URL/command
      "requires": ["python3"],           // host tools that must be present
      "restart": "on-failure"            // never | on-failure | always
    }
  },

  // Preflight — validated at launch, reported clearly instead of failing deep in a hook.
  "requires": {
    "launcher": ">=1.7.0",
    "hostDevices": ["/dev/net/tun"],
    "env": ["TS_AUTHKEY"]                // if absent → warn at launch, don't fail
  }
}
```

A `tcp`-transport host service (e.g. a host HTTP build server) looks like:

```jsonc
"hostServices": {
  "flash": {
    "start": "bazel run //tools:flash_server -- --port $PORT",
    "transport": "tcp",
    "port": 8090,                        // or "auto" to let the launcher pick
    "expose": "FLASH_SERVER",            // env var injected into the container = host:port
    "healthcheck": "http://127.0.0.1:$PORT/ports"
  }
}
```

Worked examples for the two motivating skills:

- **`tailnet`** uses `image` + `runtime` + `container` + `requires` (no
  `hostServices`). The three files it already ships (`Dockerfile.snippet`,
  `tailnet-up.sh`, and the `overlay.json` keys documented in its `SKILL.md`)
  become manifest-declared contributions. Four hand-wired locations collapse to
  one adoptable directory.
- **`host-deploy`** declares a `mount`-transport host service (+ ships
  `hostrun.sh` as an in-container file, as today). The bundled `hostdeploy.py`
  becomes the source of truth; the launcher deploys it host-side and supervises
  it — closing the "the host script is not bundled and the user must run it by
  hand" gap.

## 5. What the launcher must own

These are the actual design decisions; each is a place the implementation can get
subtly wrong.

### 5.1 Image: fragment ordering and cache correctness

- Skill Dockerfile fragments are appended **after** the project's overlay
  Dockerfile, ordered **deterministically** (by skill name), each as its **own
  layer** so unaffected layers stay cached.
- Fragments **must** fold into the image-tag hash the same way the overlay files
  already do, so toggling a skill on/off (or editing a fragment) invalidates the
  image correctly. A skill turning off must not leave its layer behind.
- Fragments run as **root at build time**; document that contract (the existing
  overlay Dockerfile already relies on it — e.g. the Nix and Tailscale layers).

### 5.2 Runtime: merge and conflict semantics for `overlay.json`

The effective overlay is `base project overlay ⊎ union of active skills`:

- `capabilities`, `devices` → **set union**.
- `env` → **union by name** (values still come from the host environment at run
  time; the manifest only names them).
- `sysctls` → union; **conflicting values for the same key is an error**, surfaced
  to the user (don't silently pick one).
- `ports` / `services` → union with **collision detection**: two skills (or a
  skill and the project) claiming the same port/name must fail loudly at launch,
  naming both claimants.

### 5.3 Boot: a `startup.d` ordering contract

- Replace the single `startup.sh` execution with an **ordered run** of: the
  project's `startup.sh` plus each active skill's `container.startup` drop-in,
  sorted by `order` then skill name.
- Codify the conventions the current scripts already follow, and require them of
  drop-ins:
  - **idempotent** (safe to re-run; a container may restart);
  - **non-fatal by default** (return 0 on a missing prerequisite so the session
    still opens — e.g. `tailnet-up.sh` returns 0 when `TS_AUTHKEY` is unset);
  - **teardown handled** where relevant (tailnet uses an *ephemeral, tagged* auth
    key so the node self-reaps on container exit — the model for "leave nothing
    behind").
- Drop-ins run as the mapped non-root user with the passwordless sudo the overlay
  installs, exactly like `startup.sh` today.

### 5.4 Host services — a first-class primitive

This is the new surface, and it should be built as **one primitive**, not as a
per-skill escape hatch. A *host service* is the mirror of the in-container
`services` that `overlay.json` already supports:

- in-container service = a **container** process, reachable from the **host** by
  name (`http://<name>.$CLAUDE_SERVICE_INSTANCE.claude.localhost/`);
- host service = a **host** process, reachable from the **container** by name,
  with the launcher managing its lifecycle.

Any project overlay or skill can declare host services (a skill declares them in
its manifest; a project could declare them in `overlay.json` under a
`hostServices` key). The launcher, for each active host service:

- **starts** it when the container comes up (cwd `$REPO_ROOT` by default, so a
  repo-mount bridge like `.hostdeploy/` is visible), **health-checks** it,
  **restarts** per `restart` policy, and **stops** it on container exit;
- **deploys the script host-side from the skill directory** (not only into the
  container) — this is what closes the "the host script is not bundled and the
  user runs it by hand" gap;
- **preflights `requires`** (e.g. `python3` present on the host) and reports a
  missing requirement at launch, not as a silent no-op;
- **wires discovery** so the container reaches the service by a stable name
  instead of a hardcoded address (see transports below).

**Two transports** cover the host bridges that exist in practice:

- `mount` — communication is via the shared repo mount, no port (this is
  `hostdeploy`: the container writes `.hostdeploy/request.json`, the host watcher
  reads it). The launcher just supervises the process; there is no endpoint to
  publish, only a health file to watch.
- `tcp` — the service listens on a host port. The launcher allocates/validates
  the port (`"auto"` or a fixed value with collision detection), maps it so the
  container can reach it (via `host.docker.internal:<port>`, optionally fronted by
  a stable `http://<name>.host.claude.localhost/` name), and **injects a
  discovery env var** (`expose`) into the container — e.g. `FLASH_SERVER=
  host.docker.internal:8090`. Container-side clients read that env var instead of
  hardcoding `host.docker.internal:8099`.

**Why one primitive.** This repo already has three host bridges that should
converge here: `hostdeploy.py` (mount transport) and `flash_server.py` /
`ios_build_server.py` (tcp transport on `host.docker.internal:<port>`, addresses
currently hardcoded in the container clients — see `tools/iosctl`,
`tools/flash_server.py`). Unifying them means the host-exec security review (§6)
happens **once, in the launcher**, and every host bridge gets supervision,
health-checking, teardown, and name-based discovery for free. `host-deploy`
becomes a thin consumer of the primitive rather than shipping its own supervisor.

### 5.5 Preflight and diagnostics

`requires` is checked **before** the failure would otherwise surface deep inside
a boot hook. Examples the launcher should report at launch time:

- launcher older than `requires.launcher` → refuse to enable the skill, name the
  needed version;
- `requires.hostDevices` not exposed by the Docker engine's VM (`/dev/net/tun`) →
  clear message, don't let `tailscale up` fail cryptically later;
- `requires.env` name absent from the host environment → **warn** (tailnet still
  opens the session; the join is skipped) rather than error.

## 6. The cross-cutting blocker: this is a privilege escalation

This is the crux and the main reason the feature cannot be bolted on casually.

**Today, adopting a skill is low-stakes** — it is instructions; the worst case is
bad advice. **The moment a skill can contribute a root `RUN`, request
`NET_ADMIN` + a device node, and start a host service, `--skills-adopt` becomes a
grant of image-build, kernel-capability, and host-code-execution authority.**

The architecture must make that explicit:

- **Consent surface at adopt/accept time.** Show the declared privileges as a
  diff before enabling, e.g.:
  - *tailnet — adds capability `NET_ADMIN`, device `/dev/net/tun`, env
    passthrough `TS_AUTHKEY`, a build layer, and a boot hook.*
  - *host-deploy — runs `python3 hostdeploy.py` on your host.*
  Re-prompt when a skill's manifest changes (a previously trusted skill that
  starts requesting new privileges must not be auto-granted them).
- **Tiers.** Keep pure-informational skills frictionless. Gate **privileged
  capability skills** (any `image`, `runtime`, or `hostServices` contribution)
  behind explicit per-project consent, sticky like the existing accept/reject
  choice.
- **Provenance for shared skills.** A capability skill is a supply-chain surface:
  its Dockerfile fragment runs as root and its host services run with the
  user's authority. Consider signing / trust-on-adopt and a way to pin a skill's
  version, especially once skills are shared beyond a single user.
- **Host-exec policy — the single most important control.** The host-services
  primitive (§5.4) runs host commands with the user's authority, so it is the one
  place the host-exec review must live. Give it a user-configured allowlist/policy
  so an adopted skill cannot start host processes beyond what the user permitted,
  and surface each `hostServices` entry's `start` command in the consent diff.
  Note that `hostdeploy.py` already self-limits at the application layer: it only
  executes commands whose `argv[0]` is in an allowlist
  (`bazel`/`bazelisk`/`nix`/`git`) and always in the repo root — a good model for
  the primitive's own policy, and for what a `tcp` service's own request handling
  should enforce.

## 7. Backward compatibility and the manual fallback

- A skill with **no** `image`/`runtime`/`container`/`hostServices` keys behaves
  exactly as today. The manifest is an upgrade, not a replacement.
- **Keep the manual path.** The current model — the agent reads `SKILL.md` and
  hand-wires the overlay — must remain valid, as the fallback when: the user has
  not consented to a skill's declared contributions; or the launcher predates
  this feature. Concretely, each capability skill should keep a "wire it by hand"
  section in its `SKILL.md` alongside the manifest (the `tailnet` and
  `host-deploy` skills already do).
- Older launchers ignore `skill.json` and simply deploy the skill as inert files
  — degraded but not broken.

## 8. Suggested implementation phases

1. **Manifest + IMAGE + RUNTIME merge.** Parse `skill.json`; fold Dockerfile
   fragments into the image build (ordering + hashing); merge `runtime` into the
   effective `overlay.json` with conflict detection. Ship `tailnet`'s image and
   runtime pieces on this. *Acceptance:* adopting `tailnet` with only
   `TS_AUTHKEY` exported produces a container with the client installed and the
   caps/device/env present — no manual overlay edits.
2. **BOOT `startup.d`.** Ordered drop-in execution with the idempotent /
   non-fatal / teardown contract. *Acceptance:* `tailnet` fully works end to end
   from adoption alone (joins the tailnet, maps peers into `/etc/hosts`, self-
   reaps on exit); no key → session still opens.
3. **Preflight + consent.** `requires` validation with clear launch-time
   diagnostics; the adopt/accept privilege-diff prompt and tiering.
   *Acceptance:* adopting a privileged skill shows its privileges and requires
   explicit consent; a missing launcher version / host device is reported at
   launch.
4. **HOST SERVICES primitive.** Build the first-class primitive (§5.4):
   launcher-supervised host processes with health-check, restart, teardown,
   name-based discovery, both `mount` and `tcp` transports, and the host-exec
   policy from §6. Deploy the host script from the skill dir. Ship `host-deploy`
   (mount transport) as the first consumer. *Acceptance:* adopting `host-deploy`
   starts and supervises the host watcher automatically; `tools/hostrun.sh` from
   the container drives a host `bazel`/`nix` command with no manual host step.
5. **Migrate the tcp bridges onto the primitive.** Move `flash_server.py` and
   `ios_build_server.py` to `tcp` host services with `expose`d discovery env
   vars, and drop the hardcoded `host.docker.internal:<port>` addresses from
   their container clients (`tools/iosctl`, etc.). *Acceptance:* the container
   clients discover the servers by injected env var; the servers are supervised
   and torn down by the launcher instead of started by hand.

## 9. Reference: the two skills this generalizes from

Both live at `.claude-container-overlay/skills/` in this repo and already bundle
their reusable scripts; they are the concrete inputs for phases 1–4.

- **`tailnet/`** — `SKILL.md`, `Dockerfile.snippet` (client install),
  `tailnet-up.sh` (join + `/etc/hosts` peer mapping). Needs `image` + `runtime`
  (`NET_ADMIN`, `/dev/net/tun`, `TS_AUTHKEY`) + `container` + `requires`
  (`launcher >= 1.7.0`, `/dev/net/tun`). Notable gotcha to preserve:
  `--accept-dns=false` on `tailscale up` (letting tailscaled rewrite
  `/etc/resolv.conf` breaks Docker's embedded DNS); peers are mapped into a
  managed `/etc/hosts` block instead.
- **`host-deploy/`** — `SKILL.md`, `hostdeploy.py` (host watcher), `hostrun.sh`
  (container client). A mailbox over the shared repo mount (`.hostdeploy/`), not
  a network proxy — a `mount`-transport host service. The watcher is un-wedgeable
  by design (stdin `/dev/null`, per-command wall-clock timeout, process-group
  kill, id-matched cancel, a liveness heartbeat on its own thread) and
  allowlists `argv[0]` — carry those properties into any generic host-exec
  primitive.
