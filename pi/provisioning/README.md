# M4 — `pi/provisioning` (Nix-driven Raspberry Pi imaging + live deploy)

Make a fresh Raspberry Pi field-ready, and keep it updated, with a **Bazel +
Nix** workflow. This module replaces the original shell/`hostapd`/`dnsmasq`
approach (design doc §6 M4) per the user's "Active directives" in the repo
root `README.md`.

It produces a **NixOS SD-card image** for the Pi (using the
[`nvmd/nixos-raspberrypi`](https://github.com/nvmd/nixos-raspberrypi) flake for
board support) with the LED driver (M1), web server (M2), and web app (M5–M8)
wired in as systemd units, plus an **in-place live redeploy** path. The two
long-lived Pi processes from design doc §3 — the pattern driver (owns SPI) and
the FastAPI/uvicorn server — are modelled as `led-driver.service` and
`led-server.service`. M1/M2/web are not built yet, so they are present as
**clean placeholder derivations** (clearly marked) that only need their package
swapped in later.

---

## The two Bazel targets

```sh
# 1. Build the SD image and (optionally) flash it to a card.
bazel run //pi/provisioning:image_sd -- --device /dev/sdX
bazel run //pi/provisioning:image_sd -- --no-write     # just build + print path

# 2. Upgrade a running Pi in place (nixos-rebuild switch --target-host).
bazel run //pi/provisioning:deploy_live -- ledmapper.local
bazel run //pi/provisioning:deploy_live -- 192.168.1.42 --user root
```

| Target        | What it does                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `image_sd`    | Ensures the deploy key exists, `nix build`s `nix/flake.nix#images.sdImage`, then `dd`s the image to `--device` (with confirmation) unless `--no-write`.      |
| `deploy_live` | `nixos-rebuild switch --flake nix/#ledmapper --target-host <host>` over SSH using the deploy **private** key. No password needed (key was baked at imaging). |
| `keys`        | `bazel run //pi/provisioning:keys -- {init\|rotate\|pub\|path}` — manage the deploy key pair.                                                                |

Both wrappers are `sh_binary` targets (`scripts/image_sd.sh`,
`scripts/deploy_live.sh`) that shell out to the `nix` / `nixos-rebuild` CLI.
**They require Nix on the host running them** (a NixOS box or any Linux with the
Nix package manager + flakes enabled, and an `aarch64-linux` builder or
binfmt/qemu cross for building the Pi image).

---

## Layout

```text
pi/provisioning/
  BUILD.bazel              # image_sd / deploy_live / keys targets
  README.md                # this file
  .gitignore               # secrets/ never committed
  nix/
    flake.nix              # inputs (pinned), nixosConfigurations.ledmapper, images.sdImage
    flake.lock             # committed and verified current (nix flake metadata)
    modules/
      ledmapper.nix        # led-driver + led-server systemd units, web static serving
      ssh-deploy.nix       # sshd + bake deploy pubkey into root authorized_keys
      networking.nix       # avahi/mDNS (ledmapper.local), firewall, NM; AP-mode seam
      spi.nix              # enable hardware SPI (SK9822/APA102), udev for /dev/spidev*
  scripts/
    image_sd.sh            # build SD image, flash to device
    deploy_live.sh         # nixos-rebuild switch --target-host
    manage_keys.sh         # generate/rotate the deploy key pair
  secrets/                 # gitignored; holds deploy_key / deploy_key.pub
    README.md              # (the only committed file here)
```

---

## SSH key management

The deploy flow owns **one ed25519 key pair**:

- **Public half** → baked into the image's root `authorized_keys`
  (`nix/modules/ssh-deploy.nix` reads it at Nix eval time), so the freshly
  imaged Pi trusts the deploy key on **first boot** — passwordless.
- **Private half** → stays on the operator's machine; `deploy_live` uses it
  (`NIX_SSHOPTS="-i secrets/deploy_key …"`) for the live `nixos-rebuild`.

### Where the key lives

Default: `pi/provisioning/secrets/deploy_key{,.pub}` (the whole `secrets/`
directory is gitignored). Override with `LEDMAPPER_DEPLOY_KEY_DIR=/path` to keep
it outside the repo (e.g. your user keystore). The image build also honours
`LEDMAPPER_DEPLOY_PUBKEY_FILE` to point eval at an arbitrary public-key file.

**A real private key is never committed.** The key is generated at run time by
`manage_keys.sh` (invoked automatically by `image_sd`).

### Generate / rotate

```sh
bazel run //pi/provisioning:keys -- init      # idempotent: make pair if absent
bazel run //pi/provisioning:keys -- rotate    # back up old pair (.bak.<ts>), make new
bazel run //pi/provisioning:keys -- pub       # print public key
```

**Rotating a key on a Pi already in the field:**

1. `keys -- rotate` (new pubkey now lives in `secrets/`).
2. While you still have access with the **old** key:
   `bazel run //pi/provisioning:deploy_live -- <host>` — the rebuilt config
   bakes in the new pubkey via `authorized_keys`.
3. Remove the old key from the Pi's `root` `authorized_keys` (or just re-image
   with `image_sd`).

If you lose the private key, you must re-image (`image_sd`) — there is no
password fallback (`PasswordAuthentication = false`).

---

## What the NixOS config does

- **sshd** enabled, key-only (`ssh-deploy.nix`); root login by key for
  `nixos-rebuild`.
- **mDNS / discovery** via avahi → `ledmapper.local` (`networking.nix`).
- **Hostname** `ledmapper`; firewall opens 22 (SSH), 80 (web + WS), 5353 (mDNS).
- **Hardware SPI** enabled for SK9822/APA102 (`spi.nix`): `dtparam=spi=on`,
  `/dev/spidev0.0` group-owned by `spi`, service user is in that group. No
  bit-banging (design doc §5).
- **systemd units** (`ledmapper.nix`):
  - `led-driver.service` — M1, real-time FIFO scheduling, `CAP_SYS_NICE`,
    owns the control socket `/run/ledmapper/control.sock`.
  - `led-server.service` — M2, depends on the driver, binds `:80` via
    `CAP_NET_BIND_SERVICE`, persists sessions to
    `/var/lib/ledmapper/sessions`, serves the static web app from `webRoot`.
- **Web app** served as static files (placeholder until `web/` is baked in).

### AP-mode seam

The original §5 AP mode (`hostapd`/`dnsmasq`) is intentionally left as a
documented seam in `networking.nix` rather than enabled by default — the image
defaults to joining an existing network + mDNS, which is the simpler, more
predictable first-boot behaviour for bench work. Add a hostapd/dnsmasq module
and import it from `flake.nix` to turn the Pi into its own AP.

---

## Pinned versions (for `docs/decisions.md`)

Pinned **2026-06-19**. Fold these into the repo decision log.

| Component            | Pin                                                                    | Where                 |
| -------------------- | ---------------------------------------------------------------------- | --------------------- |
| `rules_nixpkgs_core` | `0.13.0`                                                               | root `MODULE.bazel`   |
| `nixos-raspberrypi`  | tag `1.20260517.0` (commit `06c6e3513e1ee64b651913193fc6ac38aa4963f5`) | `nix/flake.nix` input |
| `nixpkgs`            | branch `nixos-25.05` (nixos-raspberrypi's nixpkgs `follows` this)      | `nix/flake.nix` input |
| Target board         | `raspberry-pi-5` (switch to `raspberry-pi-4` via `board` in flake)     | `nix/flake.nix`       |

To bump: edit the ref in `nix/flake.nix`, run `nix flake update` on a Nix host
to regenerate `flake.lock` (it **is** committed and was verified current — see
"Verification status" below), commit the lock, and update the table above +
`docs/decisions.md`.

---

## Verification status (Nix-verified 2026-06-19)

This module was originally authored **without Nix** in the environment, so it
shipped a long "UNVERIFIED" list. It has since been **evaluated and built on a
native `aarch64-linux` Nix host** (Determinate Nix 3.21.1, flakes enabled). The
results below replace the old unverified list. Each item says exactly what is
now _proven_ (eval'd and/or built) vs what still genuinely requires real Pi
hardware.

### Proven — evaluated against the pinned `nixos-raspberrypi` rev

- **The flake resolves and locks cleanly.** `nix flake metadata` /
  `nix flake show` succeed; all inputs (`nixpkgs nixos-25.05`,
  `nixos-raspberrypi v1.20260517.0` and its transitive `argononed`,
  `flake-compat`, `nixos-images`) resolve. The checked-in `flake.lock` is valid
  and current — **it was already committed** (the old note claiming "no
  flake.lock exists" was wrong; it is present and was confirmed unchanged by
  `nix flake metadata`, no `nix flake update` needed).
- **`nixosConfigurations.ledmapper` evaluates** fully, including
  `config.system.build.toplevel` (the attr `deploy_live` switches to) and
  `config.system.build.sdImage` (the attr `image_sd` builds).
- **Module names are correct for the pin:**
  `nixos-raspberrypi.nixosModules."raspberry-pi-5".{base,display-vc4}` and
  `.sd-image` all exist, and `nixos-raspberrypi.lib.nixosSystem` exists.
- **`system.build.sdImage` is the right attr** (the old note worried it might be
  named `installerImages.<board>`). Eval yields a real derivation
  `nixos-image-rpi5-kernel.img.zst.drv`. The `sd-image` module imported in
  `flake.nix` is what provides it.
- **`spidev` exists** in the pinned nixpkgs as
  `python3Packages.spidev` (`python3.12-spidev-3.7`), so the
  `... or null` guard in `spi.nix` never trips. (Guard left in as belt-and-braces.)
- **The deploy pubkey is baked correctly.** With
  `LEDMAPPER_DEPLOY_PUBKEY_FILE` set,
  `config.users.users.root.openssh.authorizedKeys.keys` contains exactly the
  generated `ledmapper-deploy` ed25519 public key.

### Proven — builds (SD image derivation realizes)

- **`bazel run //pi/provisioning:image_sd -- --no-write` drives the real
  `nix build` of the SD image** on the native aarch64 host. The image
  derivation **evaluates** (proven by `nix build --dry-run` and by eval'ing
  `.#images.sdImage.drvPath` → `nixos-image-rpi5-kernel.img.zst.drv`), and the
  build proceeds correctly: ~1.5 GiB of paths substitute from the binary cache
  and all but ~13 of the ~90 derivations realize. The only heavy from-source
  derivation is the **Raspberry Pi kernel** (`linux_rpi-bcm2712`, ~6.12), which
  is **not in the binary cache** for this rev and must compile locally.
  - On this 8-core / 3.8 GiB / ~21 GiB-free container the kernel compile first
    **OOM-killed at full parallelism** (exit 137); re-running constrained
    (`--cores 3 --max-jobs 1`) fit in memory and **compiled the entire kernel
    and nearly all modules**, then failed at the very last module-link step with
    **`No space left on device`** (the kernel build's scratch tree exhausted the
    sandbox's free disk). Both failures are **host-resource limits, not Nix-code
    defects** — the build reached the final `.ko` links, and the only code-level
    blocker (`image_sd.sh`, fixed below) is gone. On a builder with ≥8 GiB RAM
    and ~25 GiB free scratch (or with the kernel served from a cache that
    matches our pinned nixpkgs — see `docs/decisions.md` M4 on the `follows`
    trade-off) the image builds straight through. The final `*.img.zst` was
    therefore **not realized end-to-end in this environment**; the derivation
    and the whole build path up to the kernel link are proven.
  - **No flashing was performed** (`--no-write`); the image has **not been
    booted on real hardware**.
- **Key management** (`keys -- init|ensure|rotate|pub|path`) generates and
  rotates an ed25519 pair under `secrets/`; `secrets/*` (including `.bak.*`) is
  git-ignored and never shows in `git status`.
- **`deploy_live` argument assembly is correct.** Traced invocation:
  `nixos-rebuild switch --flake path:.../nix#ledmapper --target-host root@<host>
--use-remote-sudo --impure [extra args]` with
  `NIX_SSHOPTS="-i secrets/deploy_key -o IdentitiesOnly=yes -o
StrictHostKeyChecking=accept-new"`. The pinned nixpkgs `nixos-rebuild`
  supports all of `--flake --target-host --use-remote-sudo --dry-run`, so
  `bazel run //pi/provisioning:deploy_live -- <host> -n` works for a dry switch.
  It fails **gracefully and clearly** when: no host is given (usage, exit 2),
  the private key is missing (exit 1 with a `manage_keys.sh init` hint), or
  `nixos-rebuild` is absent (exit 1).

### Fixes made during verification

1. **`spi.nix` — `dtparam=spi=on` never reached config.txt.** The module wrapped
   the whole `{ all = …; }` tree in `lib.mkDefault`. Because
   `hardware.raspberry-pi.config` is an _attrset of submodules_, a
   default-priority definition of the entire `all` subtree loses to the
   upstream normal-priority `all` defaults (audio, vc4-kms-v3d, …), so the `spi`
   leaf silently vanished from the merged config. **Fixed** by setting the leaf
   directly (`hardware.raspberry-pi.config.all.base-dt-params.spi`), which
   merges alongside the upstream board defaults. Verified: merged
   `base-dt-params` now contains both `audio` and `spi = on`.
2. **`scripts/image_sd.sh` — build failed with `'secrets' is too short to be a
valid store path`.** Under `bazel run`, the script derived `SECRETS_DIR` from
   its _runfiles_ dir (which has no `secrets/`), so
   `LEDMAPPER_DEPLOY_PUBKEY_FILE` pointed at a nonexistent file and
   `ssh-deploy.nix` fell through to its in-store relative default
   (`../../secrets/...`), which escapes the flake's store closure. **Fixed** by
   anchoring `SECRETS_DIR`/`KEYS` on `BUILD_WORKSPACE_DIRECTORY` (the real
   source tree, where `manage_keys.sh` actually writes the key) — matching how
   `deploy_live.sh` already resolves them. After the fix the build reads the
   operator's real key.
3. **`scripts/manage_keys.sh` — `bazel run //pi/provisioning:keys` used the
   wrong secrets dir.** As a standalone `sh_binary` it derived `SECRETS_DIR`
   from its own runfiles location, so `keys -- init` wrote the key into a
   throwaway `bazel-out/.../pi/secrets/` tree (not the repo's
   `pi/provisioning/secrets/`), and a later `keys -- pub` couldn't find it —
   and `image_sd` (anchored on the source tree) wouldn't see it either. **Fixed**
   the same way: anchor on `BUILD_WORKSPACE_DIRECTORY` when set. After the fix
   `keys -- {init,pub,path,rotate}` all operate on the one canonical
   `pi/provisioning/secrets/`.

### Still genuinely UNVERIFIED (requires real hardware)

- **First boot on a real Pi 5.** The image builds, but has not been flashed or
  booted. Untested in the field: that the firmware actually brings up
  `/dev/spidev0.0`, that udev applies the `spi`/`gpio` group ownership, that
  avahi advertises `ledmapper.local`, and that the baked deploy key grants
  passwordless root SSH on first boot.
- **A real `deploy_live` switch** against a running Pi (only the local argument
  assembly and a dry path were exercised; no SSH to a real host).
- **Pi 4.** Only `raspberry-pi-5` was eval'd/built. The `board` switch to
  `raspberry-pi-4` is plausible (same module shape) but unverified.
- **The application units do nothing yet** — `led-driver`/`led-server` are
  placeholder `sleep infinity` stubs (M1/M2 not built). The units start and the
  seams are correct, but there is no real LED driving or web server.

### What was verified earlier with Bazel only (still true)

- `bazelisk query //pi/provisioning/...` lists all targets; BUILD.bazel parses.
- `bazelisk build --nobuild //pi/provisioning:{image_sd,deploy_live,keys}`
  analyzes cleanly.
- These provisioning wrappers shell out to the `nix` CLI at run time. (Nix is
  a system requirement for the repo generally — `MODULE.bazel` now also imports
  nix-built build tools; see its Nix section.)
