---
name: host-deploy
description: Run host-only build & deploy commands (e.g. `bazel run …deploy` / image builds, and other host `bazel`/`nix`/`git`) from inside a claude-container, via a shared-mailbox bridge over the repo mount. Use whenever a task needs the host's toolchain the container can't reach — a host builder VM, an SSH deploy that must originate from the host, or any `bazel run`/`nix` that must execute on the host — instead of asking the user to paste each command. Requires the user to run the watcher (`tools/hostdeploy.py`) on the host.
---

# host-deploy: drive host-side bazel/nix/deploy from the container

Some commands can't run in the container: a `bazel run //…:target.deploy` or an
image build that needs the **host's builder VM**, SSH keys/agent, or a platform
SDK, and any deploy that must SSH out **from the host**. This bridge runs those on
the host for you, driven from the container, so you can complete a deploy
end-to-end without asking the user to paste each command.

**Mechanism:** a shared *mailbox over the bind-mounted repo* (`.hostdeploy/`), not
a network proxy — no open port, no `host.docker.internal`. `hostdeploy.py` (host)
watches the mailbox; `hostrun.sh` (container) submits a command, streams its log,
and exits with the real rc. Commands are allowlisted (`bazel`/`bazelisk`/`nix`/
`git`) and always run in the repo root — it's a build/deploy driver, not a shell.

## Bundled files (travel with this skill)

- `hostdeploy.py` — the **host** watcher.
- `hostrun.sh` — the **container** client.

Both must live in the target repo's `tools/` (or anywhere under the repo), because
the host watcher reads them through the shared repo mount and the host can't see
the container's skills directory. Install into a new project once:
```sh
cp "$THIS_SKILL_DIR"/hostdeploy.py "$THIS_SKILL_DIR"/hostrun.sh tools/
chmod +x tools/hostrun.sh tools/hostdeploy.py
echo '.hostdeploy/' >> .gitignore   # runtime mailbox, never committed
```
(If a repo already ships these under `tools/`, use those — they may carry
project-specific tweaks like a custom allowlist or ssh handling.)

## Prerequisite (one-time, the user runs it)

On the **host**, from the repo root, left running:
```sh
python3 tools/hostdeploy.py
```
It watches `.hostdeploy/` and runs the commands you submit, streaming output to a
log. You cannot start a host process from inside the container — if it isn't
running, ask the user to start it.

## Preflight — is the watcher up?

It writes a heartbeat every second. Before submitting, check it's fresh (< ~8s);
`hostrun.sh` also does this and exits 3 if stale:
```sh
a=.hostdeploy/alive; [ -f "$a" ] && echo "age $(( $(date +%s) - $(date -r "$a" +%s) ))s"
```
Stale/missing → the watcher isn't running. **Ask the user to start it.**

## Submit a command

`hostrun.sh` forwards matching env (default: `SBC_*`; override the prefix with
`HOSTRUN_FORWARD`), streams the log, and exits with the real rc:
```sh
tools/hostrun.sh bazel run //path/to:target.deploy -- <arg>
```
Deploys take minutes and stream a lot, so **run it in the background and Monitor
the log** — don't block your turn:
```
Bash(run_in_background: true): tools/hostrun.sh bazel run //path/to:target.deploy -- <arg>
Monitor: tail -F .hostdeploy/<id>.log | grep -E 'Building|Built|error:|switch|rc='
```
Use `dangerouslyDisableSandbox` if network/host access is sandboxed. Cap a
runaway with `HOSTRUN_TIMEOUT=<seconds>` (the watcher kills the whole process
group at the deadline, rc=124).

## Protocol (if you drive it directly instead of via hostrun.sh)

- Submit: write `.hostdeploy/request.json` = `{"id":"<unique>","argv":[...],"env":{...}}`
  (unique id each time — the watcher runs on id-change). `hostrun.sh` does this for you.
- Output streams to `.hostdeploy/<id>.log`; completion writes
  `.hostdeploy/<id>.status` = `{"rc":N}`. Poll for the status file to know it finished.
- One command at a time (the watcher is single-threaded; `argv[0]` must be allowlisted).
- Abort an orphaned command by writing its id to `.hostdeploy/cancel`
  (`hostrun.sh` does this from its exit trap).

## Adapting to a project

- **Allowlist.** `hostdeploy.py`'s `ALLOWED = {"bazel","bazelisk","nix","git"}`
  is the safety boundary. Widen it only if the project genuinely needs another
  host tool; keep it tight — it's what stops the bridge from being a shell.
- **Env forwarding.** `hostrun.sh` forwards `SBC_*` by default. Set
  `HOSTRUN_FORWARD=MYPREFIX_` for a different convention.
- **ssh key rotation.** `hostdeploy.py` shims `ssh` to ignore `known_hosts` for
  connections that don't pin a `UserKnownHostsFile`, so deploying to a
  reflashed/reimaged host doesn't wedge on a rotated host key. If the project has
  no reflashable SSH targets, that shim is harmless; delete `ssh_shim_path` and
  its call site if you want it gone.

## Notes

- `.hostdeploy/` is the runtime mailbox — gitignore it. The two `tools/` scripts
  are committed so they're already on the host via the shared mount (no copy at
  run time).
- This only reaches the **host**. A remote target (rig/server) you reach directly
  (`ssh …`) — over the tailnet if it's tailnet-only (see the `tailnet` skill),
  independent of this bridge.
- After a deploy, **verify on the target**, not just the rc — a green
  `deploy`/build means the command succeeded, not that the hardware behaves.
