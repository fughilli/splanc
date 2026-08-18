---
name: host-deploy
description: Run host/macOS-only build & deploy commands (bazel run …deploy_live / image_sd, and other host bazel/nix) from inside the claude-container, via a shared-mailbox bridge. Use whenever a task needs the host's toolchain the container can't reach — the macOS auto-managed aarch64 builder VM, SSH-from-the-Mac deploys to a rig, or any `bazel run`/`nix` that must execute on the host — instead of asking the user to paste each command. Requires the user to have `tools/hostdeploy.py` running on the host.
---

# host-deploy: drive host-side bazel/deploy from the container

Some commands can't run in the container: `bazel run //…:NAME.deploy_live -- <rig>`
and `…image_sd` need the host's **auto-managed aarch64 builder VM** and SSH from the
Mac to the rig. `tools/hostdeploy.py` (host) + `tools/hostrun.sh` (container) bridge
this through the shared `/workspace` mount, so you can drive deploys end-to-end
without asking the user to paste each command.

## Prerequisite (one-time, user runs it)
On the **host**, from the repo root, left running:
```sh
python3 tools/hostdeploy.py
```
It watches `.hostdeploy/` and runs commands you submit (allowlisted to
`bazel`/`bazelisk`/`nix`/`git`, always in the repo root), streaming output to a log.

## Preflight — is the watcher up?
It writes a heartbeat every second. Before submitting, check it's fresh (< ~8s):
```sh
a=.hostdeploy/alive; [ -f "$a" ] && echo "age $(( $(date +%s) - $(date -r "$a" +%s) ))s"
```
Stale/missing → the watcher isn't running. **Ask the user to start it** (don't
assume; you can't start a host process from here).

## Submit a command
`tools/hostrun.sh` forwards `SBC_*` env, streams the log, and exits with the real rc:
```sh
SBC_HOSTNAME_OVERRIDE=hitl-rig-la-1 tools/hostrun.sh \
    bazel run //pi/hitl:hitl_la.deploy_live -- hitl-rig-2 --keep-builder
```
Deploys take minutes and stream a lot, so **run it in the background and Monitor
the log**, don't block your turn:
```
Bash(run_in_background: true): SBC_HOSTNAME_OVERRIDE=… tools/hostrun.sh bazel run …
Monitor: tail -F .hostdeploy/<id>.log | grep -E 'Building system closure|Built |error:|switch|rc='
```
`--keep-builder` keeps the VM warm across iterations (much faster for repeated
deploys). Use `dangerouslyDisableSandbox` if network/host access is sandboxed.

## Protocol (if you need to drive it directly)
- Submit: write `.hostdeploy/request.json` = `{"id":"<unique>","argv":[...],"env":{...}}`
  (unique id each time — the watcher runs on id-change). `hostrun.sh` does this for you.
- Output streams to `.hostdeploy/<id>.log`; completion writes
  `.hostdeploy/<id>.status` = `{"rc":N}`. Poll for the status file to know it finished.
- One command at a time (the watcher is single-threaded; `argv[0]` must be allowlisted).

## Notes
- `.hostdeploy/` is gitignored (runtime mailbox); the two `tools/` scripts live in the
  repo so they're already on the host via the shared mount — no copy needed.
- This only reaches the **host**. The rig itself you reach directly over Tailscale
  (`ssh root@<rig>`), independent of this bridge.
- After a deploy, verify on the rig over SSH (interfaces, `systemctl`, `/status`) —
  a green `deploy_live` means the closure switched, not that the hardware behaves.
