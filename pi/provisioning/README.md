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

| Target        | What it does                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_sd`    | Ensures the deploy key exists, `nix build`s `nix/flake.nix#images.sdImage`, then `dd`s the image to `--device` (with confirmation) unless `--no-write`.       |
| `deploy_live` | `nixos-rebuild switch --flake nix/#ledmapper --target-host <host>` over SSH using the deploy **private** key. No password needed (key was baked at imaging). |
| `keys`        | `bazel run //pi/provisioning:keys -- {init\|rotate\|pub\|path}` — manage the deploy key pair.                                                                 |

Both wrappers are `sh_binary` targets (`scripts/image_sd.sh`,
`scripts/deploy_live.sh`) that shell out to the `nix` / `nixos-rebuild` CLI.
**They require Nix on the host running them** (a NixOS box or any Linux with the
Nix package manager + flakes enabled, and an `aarch64-linux` builder or
binfmt/qemu cross for building the Pi image).

---

## Layout

```
pi/provisioning/
  BUILD.bazel              # image_sd / deploy_live / keys targets
  README.md                # this file
  .gitignore               # secrets/ never committed
  nix/
    flake.nix              # inputs (pinned), nixosConfigurations.ledmapper, images.sdImage
    flake.lock             # NOT generated here (no nix) — see "Unverified"
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

| Component            | Pin                                                                   | Where                                |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| `rules_nixpkgs_core` | `0.13.0`                                                             | root `MODULE.bazel`                  |
| `nixos-raspberrypi`  | tag `1.20260517.0` (commit `06c6e3513e1ee64b651913193fc6ac38aa4963f5`) | `nix/flake.nix` input               |
| `nixpkgs`            | branch `nixos-25.05` (nixos-raspberrypi's nixpkgs `follows` this)     | `nix/flake.nix` input               |
| Target board         | `raspberry-pi-5` (switch to `raspberry-pi-4` via `board` in flake)   | `nix/flake.nix`                     |

To bump: edit the ref in `nix/flake.nix`, run `nix flake update` on a Nix host
to regenerate `flake.lock` (it does **not** exist yet — see below), commit the
lock, and update the table above + `docs/decisions.md`.

---

## UNVERIFIED (no Nix in the authoring environment)

`nix` is **not installed** in the environment where this module was written
(`which nix` fails), so nothing Nix-related could be executed. The following is
authored to be correct but **has not been built or evaluated** — treat as
review-ready, not proven:

1. **`nix/flake.nix` and all `nix/modules/*.nix` were never evaluated.** Option
   paths that depend on the pinned `nixos-raspberrypi` revision may need small
   adjustments:
   - `spi.nix` uses `hardware.raspberry-pi.config.all.base-dt-params.spi` for
     `dtparam=spi=on`. Confirm this option path exists in the pinned flake; if
     not, set the equivalent firmware config knob it exposes.
   - `flake.nix` reads the SD image from
     `nixosConfigurations.ledmapper.config.system.build.sdImage`. Confirm the
     upstream flake builds `sdImage` for the chosen board (it may name it
     differently, e.g. an `installerImages.<board>` package).
   - The `raspberry-pi-5.base` / `.display-vc4` module names follow the
     upstream README; verify against the pinned rev.
2. **No `flake.lock` is checked in** — it must be generated with
   `nix flake update` on a machine with Nix. Without it, input hashes are not
   pinned at the lock level (only the refs in `flake.nix` are pinned).
3. **`spi.nix`** references `python3Packages.spidev or null`; if `spidev` is not
   in the pinned nixpkgs under that attr, drop it. (`or null` guards eval.)
4. **The two `sh_binary` targets cannot be `bazel run` to completion** without
   Nix — they detect a missing `nix`/`nixos-rebuild` and exit with a clear
   error. The SD image must be built on an `aarch64-linux` builder (native Pi,
   remote builder, or binfmt/qemu cross).
5. **SSH pubkey eval path** (`ssh-deploy.nix`) resolves
   `../../secrets/deploy_key.pub` relative to the module file. Confirm the
   relative path resolves correctly from the flake's copy in the Nix store on a
   real build (the `secrets/` dir must be inside the flake's source closure, or
   pass `LEDMAPPER_DEPLOY_PUBKEY_FILE`).

### What WAS verified (in this environment, with Bazel only)

- `bazelisk query //pi/provisioning/...` lists all targets — BUILD.bazel parses.
- `bazelisk build --nobuild //pi/provisioning:{image_sd,deploy_live,keys}`
  analyzes cleanly (3 targets configured, 0 errors).
- `bazelisk query //...` over the whole repo still loads after the
  `MODULE.bazel` change (rules_nixpkgs_core 0.13.0 resolves from the registry;
  the other agent's `shared/protocol` targets are unaffected).
- The `MODULE.bazel` change is **registration-only** — no `nix_repo` /
  `nixpkgs_package` is declared, so Bazel never tries to evaluate Nix at fetch
  time. This is deliberate: declaring one would break `bazel build //...` for
  anyone without Nix installed.
