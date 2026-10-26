# Splanc MAX updates over the air

Status: implemented (PR "Splanc MAX over-the-air updates"). HITL results at the end.

A **Splanc MAX** is a Raspberry Pi driving a Tang Nano 9K FPGA (the `spi_ws281x`
gateware) over SPI. Until now it could only be updated by re-flashing a `pi-v*` SD
image or by a developer running `deploy_live` with the deploy key. Now a MAX updates
the way a C6 fixture does: the web app's **"Update over Wi-Fi"**, the agent's
**`update_firmware`** and the **bridge** all work, with one dispatch on the device.

What is different from the C6 (docs/design/ota.md):

- **The unit is a whole NixOS system**, not a 2 MB app image.
- **The Pi downloads its image itself.** The client sends only the 108-byte signed
  manifest.
- **A new system is booted exactly once.** It is kept only after the player proves
  healthy. Otherwise U-Boot's default, the old system, comes back by itself: after
  a crash, a hang, a reset or a power cut.

## The update unit: a NixOS generation, booted once

The options, for an SD card in a fixture that can lose power at any moment:

| | Writes per update | Power-loss story | Keeps device state | Migration |
|---|---|---|---|---|
| **A/B root partitions** | the whole root (≈1.5–3 GB) | good: flip a partition | needs a separate state partition | re-partition every card |
| **NixOS generation + one-shot trial boot** (chosen) | only the store paths that changed | the bootloader default never changes until healthy | free: /etc and /var are untouched | one deploy or SD flash (already needed: v1.0.0 has no OTA arms) |
| `switch-to-configuration switch` in place (what `deploy_live` does) | changed paths | none: a bad system becomes the default at once | free | none |

**Why the generation.**

- **SD wear.** `nix-store --import` skips every path already in the store, so an
  update writes only what changed. A delta image (below) doesn't even transfer the
  rest. An A/B root rewrites the whole filesystem every time.
- **Power-loss safety.** Each store path is written, then registered in the Nix
  database in one SQLite transaction; a cut leaves an invalid path that the next
  import rewrites. Every file the updater writes outside the store is
  temp + fsync + rename + fsync(dir). Most importantly, the default boot entry
  (`/boot/extlinux/extlinux.conf`) is not touched until the new system has proven
  healthy (see Trial boot), so the state after a cut is always "the old system", or
  "the new system, healthy and committed".
- **State survives for free.** A generation switch leaves /etc's stateful parts and
  all of /var alone. An A/B root would have to move Wi-Fi, identity and the stored
  map onto a third partition, then re-partition every card in the field.
- **It's what NixOS already does.** `deploy_live` is `nix copy` + `nix-env --set` +
  `switch-to-configuration`. OTA adds the download, the signature, and *when* the
  switch happens.

### Trial boot (one-shot)

The released fleet is Pi 3. The Pi 3, Pi 4 and Zero 2W boot through U-Boot +
extlinux (nixos-raspberrypi's default). The Pi 5 boots its kernel straight from the
firmware (see "Boards").

The Pi 3 firmware has no `tryboot`, so the one-shot lives in **U-Boot**.
`pi/provisioning/nix/ota.nix` builds U-Boot 2025.01 (`rpi_arm64_defconfig`) with a
`PREBOOT` that runs before the stock `bootflow scan`:

```text
pci enum; usb start;
if load mmc 0:1 ${scriptaddr} splanc-trial && itest.b *${scriptaddr} == 0x31; then
  mw.b ${scriptaddr} 0x30 1; fatwrite mmc 0:1 ${scriptaddr} splanc-trial ${filesize};
  sysboot mmc 0:2 any ${pxefile_addr_r} /boot/extlinux/splanc-trial.conf;
fi
```

- `/boot/firmware/splanc-trial` (FAT) holds `1 <nonce>` when armed.
- U-Boot rewrites the first byte to `0` **before** it loads the trial kernel, so the
  trial boots once.
- Anything that fails returns to the stock boot, which reads `extlinux.conf`, which
  still names the old system. That covers no flag, a `0`, a missing trial conf and a
  missing kernel.
- The trial entry `/boot/extlinux/splanc-trial.conf` is written in the NixOS
  extlinux builder's own format, with the builder's file names
  (`pi/max_ota/src/extlinux.rs`). Its `APPEND` adds `splanc.ota=trial`.
- Any later `switch-to-configuration` deletes boot files no generation uses. A stale
  trial can therefore only vanish; it can never become a default.

**What brings the old system back:**

| Failure in the trial | What happens |
|---|---|
| kernel panic | `panic=10`, reboot; the flag reads `0`, so the old system boots |
| hung kernel or userspace | the BCM2835 hardware watchdog (`systemd.watchdog.runtimeTime = 15s`) resets the board; the old system boots |
| player never healthy | the updater's deadline (300 s) reboots; the old system boots |
| power cut | the old system boots |
| U-Boot didn't clear the flag | the updater clears it itself on entering the trial; a second trial boot is rolled back |

The updater refuses to stage anything (`bootloader_unsupported`) unless the U-Boot
binary on the firmware partition contains the marker, because a stock U-Boot would
ignore the flag.

### Flow

```text
client: ota_begin{manifest, source_url?}         player (unprivileged): check signature,
        <- ota_status{DOWNLOADING}               board, key, version; write inbox/request
root updater (splanc-ota-apply, path unit on the inbox):
   check again (the authority) -> curl -C - into dl/<sha>.part  (resumable)
   size + SHA-256 = the signed digest -> dl/<sha>.img
   header: board + version must match the manifest; delta base paths must be valid
   zstd -dc | nix-store --import -> GC root on the new toplevel
   copy kernel/initrd to /boot/nixos, write splanc-trial.conf, state = staged,
   THEN arm the flag (1 <nonce>)                 <- ota_status{INSTALLED}
   reboot
U-Boot: flag 1 -> 0, sysboot the trial
splanc-ota-boot (every boot, before the player): booted == new && splanc.ota=trial -> trial
splanc-ota-health: player healthy before the deadline?
   yes -> nix-env --set + switch-to-configuration boot (extlinux default = new),
          drop the trial entry, raise the security floor, collect garbage -> "ok"
   no  -> state "rolled_back", reboot -> U-Boot boots extlinux.conf (old)
client: polls get_ota_status through the reboots until last_result ok / rolled_back
```

### Power loss at every step

`//pi/max_ota:updater_test` cuts the power at **every** mutating step of a whole
update, from the request to the commit (30 cut points). The fake Pi has a
filesystem, a Nix store, a web server, U-Boot's PREBOOT and the extlinux builder.

**Every cut point recovers:**

- the Pi boots a complete system, old or new, never anything else;
- if it boots the new one, that system is committed (`ok`) and is the extlinux
  default;
- if it boots the old one, extlinux.conf still names it;
- a retry from the client then always reaches the new system.

**Outcomes over the 30 cut points:** 25 end on the new system with no retry,
because a cut during the download resumes and a cut during staging re-stages. 3
roll back. 2 lose the request before it was persisted.

**Where each cut lands:**

| Cut during | After power returns |
|---|---|
| request, before the state is saved | idle on the old system; the client retries |
| download | `splanc-ota-apply` resumes the `.part` at boot (`curl -C -`) |
| import / staging, before the flag is armed | the boot reconcile re-stages (the import is idempotent) |
| after the flag, before the reboot | U-Boot runs the trial on the next power-up |
| trial | the old system; `rolled_back` (`trial_failed` / `trial_reset`) |
| commit (`nix-env --set`, `switch-to-configuration boot`) | the boot reconcile finishes the commit; if the old system booted, it reboots once into the new default |

## Signing

**The manifest** is the C6's 108-byte manifest, unchanged (`splanc_ota::manifest`):
version, size, SHA-256 of the image, flags, then ECDSA P-256 r‖s over SHA-256 of
the first 44 bytes.

**The flags:**

| bits | field |
|---|---|
| 0 | loader image (refused) |
| 8–15 | key id: **3** `max` (every release) or **4** `max_backup` (offline, rotation only) |
| 16–23 | security version |
| 24–31 | **board**: 1 `pi3`, 2 `pi4`, 3 `pi5`, 4 `zero2w`; 0 = not a MAX image |

**The keyring.** It is the same keyring and tooling as the C6
(`firmware/ota/keys`, `ota_sign`, key epochs, security floor), but the MAX trusts
**only its own key ids**:

| id | name | file | role |
|---|---|---|---|
| 3 | `max` | `keys/max.pub` | online: the `MAX_OTA_SIGNING_KEY` secret signs every MAX release |
| 4 | `max_backup` | `keys/max_backup.pub` | **offline**, in cold storage, never in CI; signs the key-epoch record that revokes a compromised `max`, and the bridge image of a rotation |

An `UNSET` entry verifies nothing, and the build works with it (as with `max.pub`
before the owner creates it). A manifest names its key id and is verified against
**that key only**. Ids 5–7 are free for a successor key after a rotation (below).

- **Never the loader ring's keys.** The C6 loader trusts 0 `release`, 1 `backup` and
  2 `next`; the MAX updater trusts none of them.
- **Never a bare sha256** (contrast `pi/bridge/selfupdate.py`).
- **Separation both ways.** A C6 image can't install on a MAX: board 0 is refused as
  `wrong_board`, and key 0 as `unknown_key`. A MAX key can't sign C6 firmware: the
  loaders don't have it.
- **Where the ring comes from.** `firmware/ota/ring.bzl` holds `MAX_RELEASE_RING`
  (`max` + `max_backup`) / `MAX_TEST_RING` (`test_max` + `test_max_backup`).
  `gen_key_header.py --lang rust` writes the ring as a Rust const into
  `//pi/max_ota`. `--//firmware/ota:trust=test` swaps in the TEST keys, as it does
  for the C6 loader (release/backup ↔ test/test_backup).
- **Who checks.** The player checks every offer for a quick answer. The root updater
  checks it again before it downloads anything; it is the authority.

**Key files:**

| file | |
|---|---|
| `firmware/ota/keys/max.pub` | the public half of the `MAX_OTA_SIGNING_KEY` secret (**UNSET** until the owner creates it, below) |
| `firmware/ota/keys/max_backup.pub` | **UNSET** until the owner creates it (below): the public half of the offline backup key. Its private half is never in the repo or CI |
| `firmware/ota/keys/test_max.key` / `.pub` | the public TEST `max` key (id 3): HITL and development images only |
| `firmware/ota/keys/test_max_backup.key` / `.pub` | the public TEST `max_backup` key (id 4): key epochs and backup-signed images in test-trust updaters and the host tests |

**Key epochs.** The updater applies a key-epoch record (`ota_begin.key_epoch`)
whose signer is in the MAX ring. Records signed by other keys, such as the C6's
`key-epoch.bin`, are ignored rather than refused, so a client that sends the C6
record by mistake can't block an update. A MAX revocation ships as
`max-key-epoch.bin` (from `firmware/ota/keys/max_epoch.bin`). The rules are the C6's
(docs/design/ota.md "Key rotation"): the epoch must rise, revocations never shrink, a
record can't revoke its own signer, and a revoked key signs nothing more, records
included. The revocations are device state (`/var/lib/splanc-ota`), so they outlive
every later update; only a re-flash resets them.

### Key rotation

The ring is part of the system image, so on a MAX (unlike the C6 loader) **a new
ring ships over the air**: the bridge image below carries it. What can't come over
the air is trust in a key the running system doesn't know, which is why the backup
(id 4) has to be in the ring *before* it is needed. A unit whose system predates
`max_backup.pub` (an `UNSET` slot) ignores backup-signed records and refuses
backup-signed images as `unknown_key`: a compromise of `max` reaches it only via
`deploy_live` or a re-flash.

**Runbook: the `max` key is compromised.**

1. **Take the backup out of cold storage.** On an offline machine, sign an epoch
   revoking id 3 (`<stored+1>`: 1 for the first record):

   ```
   ota_sign epoch --key-file max_backup.key --key-id 4 --epoch <stored+1> --revoke 3 --out max_epoch.bin
   ota_sign verify-epoch --ring 3=keys/max.pub,4=keys/max_backup.pub --in max_epoch.bin
   ```
2. **Commit it as `firmware/ota/keys/max_epoch.bin`.** Every release now ships it as
   `max-key-epoch.bin`, and the web app and the agent send it with `ota_begin`. Each
   unit applies it at its next update attempt and from then on refuses anything the
   stolen key signs (`revoked_key`). Revoked ids are never reused.
3. **Generate the successor online key** (`ota_sign keygen`), and give it a **fresh
   id** (5, `max_next`): add `"5": "//firmware/ota:keys/max_next.pub"` to
   `MAX_RELEASE_RING` (and a TEST counterpart), point `MAX_OTA_SIGNING_KEY` at its
   private half, and pass `--key-id 5` in the release workflow's `max` job.
4. **Sign one bridge release with the backup**, by hand on the offline machine, for
   the release that first carries the new ring (CI can't: the units don't trust id 5
   yet, and nothing in CI holds the backup):

   ```
   python3 tools/max_ota_release.py --toplevel <system> --board pi3 --version X.Y.Z \
     --signer ota_sign --pubkey firmware/ota/keys/max_backup.pub \
     --key-id 4 --key-file max_backup.key --out-dir _assets
   ```

   Upload the `.nixclosure` / `.manifest` to the release. Once the units run it they
   trust id 5, and CI signs with it from the next release on.
5. **Put the backup back in cold storage.** A replacement backup (if it was
   exposed) is a new id too, added the same way.

The tests (`//pi/max_ota:updater_test`, "rotation" below) run this end to end with
the TEST keys: a backup-signed record revoking `max`, after which max-signed images
are refused and backup-signed ones install.

**Anti-rollback.** It works exactly as on the C6:

- `allow_downgrade` lets a client install an older version;
- the **security floor** (raised at every commit) refuses older security versions
  regardless.

## Download

- **The client sends only the manifest.** The Pi fetches the image itself. It is not
  streamed over the control connection: a phone can sleep, a laptop can close, and
  the agent can be on another network. The Pi has a full TLS stack (curl) and its
  own network, so the update carries on regardless.
- **Where it fetches from.** By default, the release asset for the manifest's version
  and the Pi's board:
  `https://github.com/fughilli/splanc/releases/download/firmware-vX.Y.Z/max-<board>-X.Y.Z.nixclosure`.
- **`ota_begin.source_url`** (new field 4) overrides it with any http(s) URL: a LAN
  mirror for a MAX without internet, a development build, or the HITL gate's tunnel.
  The URL decides nothing about what installs; the signed digest does.
- **Resumable.** The download is `curl -C -` into `dl/<sha>.part`, flushed every
  second, so a power cut keeps what arrived. At boot, `splanc-ota-apply` resumes it.
  It retries 5 times with backoff, then `download_failed: <curl error>`.
- **Verified before use.** Nothing is imported until the whole file's size and
  SHA-256 match the signed manifest.

### The image (`.nixclosure`)

```text
SPLANC-MAX-OTA 1
board: pi3
version: 1010000
toplevel: /nix/store/…-nixos-system-ledmapper-…
compression: zstd
base: /nix/store/…        (delta only: paths left out, which the device must have)

<zstd(nix-store --export <paths>)>
```

The manifest's size and SHA-256 cover the whole file, header included.

- **Full image:** the whole closure.
- **Delta (`--base-toplevel`):** only the paths the base system doesn't have. The
  updater checks every `base:` path is valid before importing anything
  (`missing_base` otherwise).

`tools/max_ota_release.py` packs and signs both (stdlib Python, `nix-store`, `zstd`,
`ota_sign`).

## Health proof

The player (`pi/player_rs`) writes `/run/ledmapper/health` every 2 s:

- `listening=1` once its WSS listener is bound;
- `ticks`: the frames its render loop pushed to SPI;
- `up_ms`.

The trial is kept only if, before the **300 s deadline**, all of these hold
(`splanc_max_ota::health`, host-tested):

- the player has been up for ≥ 20 s;
- it is listening;
- `ticks` advanced across two samples ≥ 5 s apart;
- if the old system had a default route when it staged the update, the new one has
  one too.

**Why the network rule.** A system that can't reach the network can't be fixed over
the network, so it isn't kept. Unlike the C6, a MAX that loses its AP for the
trial's duration just keeps the old system, and the update can be retried.

**The deadline.** It counts from the trial's boot reconcile and uses
`CLOCK_BOOTTIME` (a Pi has no RTC, and NTP moves the wall clock after boot). It is
long because the player starts only after the FPGA is re-flashed with the new
gateware, when the gateware changed.

## FPGA bitstream versioning

**The gateware is part of the system.** It is the Bazel-built
`spi_ws281x_tangnano9k.fs`, in the closure as `build_data`. The Tang is commissioned
at every player start (`fpga.nix` / `apps.nix`):

- The sha256 of the `.fs` is stamped into the Tang's own SPI flash at 0x300000.
- The bitstream is re-flashed only when the stamp differs.

A trial boot of a new gateware flashes it, and a rollback flashes the old one back:
the gateware always follows the system that booted, with no Pi-side state to drift.

**Power-loss fix (this PR).** The commission now **invalidates the stamp before
flashing**. Before, a cut mid-flash left the previous gateware's stamp next to a
half-written bitstream, so the next boot of that previous system skipped the flash.
That is exactly the rollback case.

## Device state kept across updates

An OTA image is built once per board, not per device. Everything that makes a unit
itself therefore lives outside the system closure:

| State | Where | Across an update |
|---|---|---|
| Wi-Fi credentials | NetworkManager `/etc/NetworkManager/system-connections` (Improv writes them) | untouched by a generation switch |
| hostname | `/var/lib/sbc/hostname` (sbc-deploy writes it once) | the image bakes **no** hostname (`networking.hostName = ""`), so NixOS doesn't own `/etc/hostname` or avahi's `host-name`; activation writes `/etc/hostname` from the committed name, and avahi advertises `<name>.local` (a fresh unit takes the commissioning `--hostname`, else `ledmapper`) |
| SSH host keys | `/etc/ssh/ssh_host_*` | untouched |
| deploy key | `/var/lib/sbc/authorized_keys.d/root` | seeded once from the keys of the first OTA-capable system (a developer's `deploy_live`, or the SD image), then never rewritten; sshd reads it alongside the baked keys |
| stored map / app data | `/var/lib/ledmapper` | untouched |
| update state | `/var/lib/splanc-ota` | the updater's own |

The HITL gate checks each of these before and after every phase.

## Boards: one artifact per board

Each board needs its own kernel, firmware and device tree, so each one has its own
artifact (`max-<board>-<ver>.{nixclosure,manifest}`) and its own board id in the
signed flags. The updater checks the board twice:

- against the hardware (`/proc/device-tree/model`, the same identity sbc-deploy's
  brick guard reads);
- against the image header.

| Board | Boot path | Trial boot | Status |
|---|---|---|---|
| Pi 3 (released fleet, HITL `pi-ledmapper-1/2`) | U-Boot + extlinux | U-Boot PREBOOT one-shot | **implemented, HITL-tested** |
| Zero 2W | U-Boot + extlinux (`rpi_arm64` U-Boot) | same | same code; needs an `sbc_application` target + a release matrix row |
| Pi 4 | U-Boot + extlinux | same (or firmware `tryboot`) | same code; needs a target + a matrix row |
| Pi 5 | firmware loads the kernel (`kernel` generational bootloader on SD images) | firmware **`tryboot`**: `tryboot.txt` with `os_prefix=nixos/<gen>/`, `reboot "0 tryboot"` | refused (`bootloader_unsupported`) until wired |

The release workflow's `max` job is a matrix over boards. Pi 3 is the only row
today.

## Transport (`ledmapper.proto`)

**Messages.** The same arms as the C6: `ota_begin` / `get_ota_status` /
`ota_abort` → `ota_status`. The additions:

- `OtaBegin.source_url = 4`
- `OtaStatus.board = 17`
- `OtaStatus.State.STATE_DOWNLOADING = 6`
- the welcome feature **`ota_pull`**

**How the player answers.** `pi/player_rs/src/ota.rs` uses the loader's zero-copy
codec (`splanc_ota::wire`, now with those fields). The host profile's by-value
envelopes overflow a worker stack.

- **`ota_begin`**: `DOWNLOADING`, or `FAILED` + `error`.
- **`get_ota_status`**: mode `APP` (a MAX has no loader), the state mapped from the
  updater's phase, `offset` = bytes downloaded, `board`, `app_version`,
  `last_result`, key state, `max_chunk = 0`.
- **`ota_chunk` / `ota_finish`**: `pull_only`.

**What the player and the updater share.** The player is unprivileged (user
`ledmapper`) and talks to the root updater only through
`/var/lib/splanc-ota/inbox/` (group-writable) and the world-readable state file.

**Error codes added for MAX:** `wrong_board`, `busy`, `bad_url`, `pull_only`,
`download_failed`, `bad_image`, `missing_base`, `import_failed`,
`bootloader_unsupported`.

## UX and clients

- **Web app.** `web/src/net/otaUpdate.ts` `updateFirmware` dispatches on `ota_pull`:
  `pullUpdate` sends the manifest and follows the device through download → verify →
  reboot → health, reconnecting across reboots. The Flash screen shows
  **"Update ⟨name⟩ over Wi-Fi"** for a MAX. It fetches
  `max-<board>-<ver>.manifest` (and `max-key-epoch.bin`) from the selected release,
  with `board` taken from `ota_status`. Progress reads "The device is downloading the
  firmware… n%", then the C6's verify / reboot / health steps.
- **Agent `update_firmware`.** It resolves one package per kind of player: the C6
  `.ota`, or the board's manifest. A mixed fleet still rolls out canary-first. For
  development, `SPLANC_MAX_OTA_MANIFEST` and `SPLANC_MAX_OTA_SOURCE_URL` override
  the release.
- **Bridge.** It hosts the same MCP server, so it is unchanged.
- **Python (HITL).** `ota_core.pull()`.

## Release artifacts and cadence

MAX images are built **alongside the firmware releases**: the `max` job runs on
every `firmware-v*` tag, after the C6 job, onto the same release.

| Asset | |
|---|---|
| `max-pi3-X.Y.Z.nixclosure` | the image (full closure, zstd -19) |
| `max-pi3-X.Y.Z.manifest` | 108 bytes, signed with `MAX_OTA_SIGNING_KEY` (key id 3, board 1). CI never signs with `max_backup` (id 4): it has no secret, and `max_ota_release.py` refuses `--key-id 4` without `--key-file` |
| `max-key-epoch.bin` | when `firmware/ota/keys/max_epoch.bin` exists |

- **The version.** The system is stamped with the release version
  (`SPLANC_MAX_VERSION` → `/etc/splanc-max/version`), so "latest" names the same
  version for every fixture.
- **No key yet.** The job **skips with a warning**, without failing the firmware
  release, while `max.pub` is UNSET or the secret is missing.
- **SD images.** `pi-v*` SD images keep their own tag. They report version 0
  (`0.0.0-dev`) until their first OTA, so any release updates them.

## Migration (once)

`pi-v1.0.0` units have no OTA arms, no updater and a stock U-Boot. They need **one**
of:

- a new SD image (the next `pi-v*`);
- `bazel run //pi/provisioning:update -- <host>` / `deploy_live`.

That first OTA-capable system installs the trial U-Boot on the firmware partition
(the U-Boot builder copies it at every switch) and seeds the persistent deploy key.
From then on, everything is over the air. Until then the updater refuses with
`bootloader_unsupported`, so the C6 clients' "Update over Wi-Fi" can't strand a
v1.0.0 unit.

## Testing

**Host tests** (all in `bazel test //...`):

| Target | Covers |
|---|---|
| `//pi/max_ota:updater_test` | the simulated Pi: happy path, refusals (`bad_signature`, `wrong_board`, a C6-style manifest, the loader ring's key id, `downgrade`, `bad_manifest`, Pi 5, a stock U-Boot, `bad_url`), security floor, an unhealthy trial, a trial kernel panic, no network in the trial, download retries, delta base check, a tampered image, key epochs, **rotation** (the ring holds `max` + `max_backup`; backup-signed images install; a backup-signed epoch revokes `max`, after which max-signed images and max-signed records are refused and the backup's bridge image installs; the backup can't revoke itself or un-revoke; an `UNSET` backup slot verifies nothing), and the **power cut at every step** sweep |
| `//pi/max_ota:max_ota_unit_test` | header, extlinux mirror, health verdicts, state/request round trips |
| `//pi/player_rs:player_rs_test` | the OTA arms, status mapping, pending request, download offset, `pull_only`, the welcome features |
| `//firmware/ota:wire_test` | `source_url`, `board` and `STATE_DOWNLOADING` against the generated bindings |
| `//web:otaPull_test` | `pullUpdate` against a simulated MAX (rollback, refusals, dispatch) |
| `//agent:firmware_test` | the MAX manifest + MAX key epoch resolution |
| `//pi/hitl/tests:hitl_test` (`test_max_ota_core.py`) | the Python `pull()` client |

**HITL gate** (`//pi/hitl/harness:max_ota_gate`, a `py_binary` tagged `hitl` +
`manual`). Its images are Nix-built: `pi/hitl/max_ota_images.sh OUT` builds A/B/U
with TEST trust and packs deltas. It runs on rig-1's `pi-ledmapper-1/2` in one
reservation:

- **setup:** deploy A over SSH and record the state;
- **upgrade:** A → B;
- **badsig;**
- **unhealthy:** U rolls back to B;
- **powercut:** B → A with an immediate reset mid-download, then resume;
- **trialcut:** A → B with a reset during the trial; back on A.

The network DUTs have no switchable power. `echo b > /proc/sysrq-trigger` resets
immediately, with no sync and no unmount, which is what a cut does to the
filesystem. Journals of the OTA units and the player are saved per phase.

## What the owner must do (decisions)

1. **Create the MAX signing key offline:**

   ```
   bazel run //firmware/ota:ota_sign -- keygen
   ```

   - Commit the `public` line as `firmware/ota/keys/max.pub` (replacing `UNSET`).
   - Store the `private` line as the **`MAX_OTA_SIGNING_KEY`** repository secret
     (Settings → Secrets and variables → Actions; 64 lowercase hex characters).

   Until both exist, releases carry no MAX images. Units can still be updated with
   `deploy_live`, and test-trust units with test-signed images.
2. **Create the MAX backup key offline** (decided: yes). It is the only way to
   revoke a compromised `max` key without a re-flash. The slot (id 4,
   `keys/max_backup.pub` in `MAX_RELEASE_RING`) is in place and `UNSET`. On an
   offline machine:

   ```
   bazel run //firmware/ota:ota_sign -- keygen
   ```

   - Keep the `private` line **offline** (cold storage, like the C6 `backup`). Never
     in the repo, never a CI secret: nothing in CI signs with it.
   - Commit the `public` line as `firmware/ota/keys/max_backup.pub` (replacing
     `UNSET`, keep the comment lines).
   - Check that the two keys differ: `max.pub` and `max_backup.pub` must not hold the
     same line, and neither may be the C6's `release.pub` / `backup.pub`.

   Every MAX system built from then on trusts it; units only gain it by installing
   such a system (an update or a re-flash).
3. **Internet for MAX units.** By default the Pi downloads from github.com. A
   fixture on an isolated LAN needs a mirror passed as `source_url`; the bridge
   could serve one. That is not built yet.

## Limitations and follow-ups

- **Pi 5 / Pi 4 / Zero 2W** aren't wired yet (see "Boards"). Pi 5 needs its tryboot
  backend.
- **Release images are full closures.** Deltas exist in the tool and the updater,
  but CI doesn't keep the previous release's closure to diff against.
- **A trial that changes the gateware re-flashes the Tang twice on rollback**
  (new, then old). That is a few seconds of dark LEDs each time.
- **The first OTA-capable system needs a deploy or an SD flash** (Migration).
- The updater keeps the current and the previous generation. A full disk shows up
  as `import_failed` or `flash_error`.

## HITL results

`//pi/hitl/harness:max_ota_gate` on rig-1 / **pi-ledmapper-1** (splanc-max-2: Pi 3
Model B+ Rev 1.4 with its Tang Nano 9K), in one reservation, 2026-10-23. The images
are `pi/hitl/max_ota_images.sh` deltas of 66 KB (A↔B) and 3.4 MB (U), all TEST-signed.

**Verdict: PASS.** Every check passed, across two runs in the same reservation:

- **run 5:** setup, upgrade, badsig, unhealthy, trialcut;
- **run 6:** powercut, re-run alone with the download throttled, because the
  66 KB delta had finished before the gate could cut it.

| phase | result | numbers |
|---|---|---|
| setup | PASS | deploy over SSH 80 s. The first OTA-capable system and the trial U-Boot boot on real hardware. Hostname, Wi-Fi profiles, SSH host key and /var/lib/ledmapper kept; the deploy key was persisted |
| upgrade A→B | PASS | **77 s total**: download 4 s, then the trial boot (U-Boot one-shot), healthy and committed 29 s after the trial came up. Runs B; all state kept |
| bad signature | PASS | refused (`bad_signature`) before anything was fetched (dl/ empty); still on B |
| unhealthy (U) | PASS | U booted once; no health file; rolled back at the 300 s deadline; **back on B by itself** (`unhealthy: no health file`) |
| power cut mid-download | PASS | `sysrq b` at 28,672 / 66,362 B. The Pi came back on A; `splanc-ota-apply` resumed at 28,672 (HTTP Range); installed, healthy, committed: **runs B** (126 s) |
| power cut in the trial | PASS | `sysrq b` while the trial was up and not yet proven. U-Boot booted the old default: **back on A**, `rolled_back` (`trial_reset`), 84 s |

The device ends on B, a working system.

**What the first runs found, all fixed in this PR:**

- **The player SEGV'd at start.** On `main` the host-profile `Player::handle` needs
  **8.2 MiB of stack** (`sub sp, #0x82b000`), more than the 8 MiB main thread and the
  8 MiB tokio workers. Both `--start N` and every client frame crashed the static-musl
  player in a loop. It now runs on 32 MiB stacks.
- **spidev's 4 KiB buffer.** It made every 6.6 KB FPGA frame (4 × 550 LEDs) fail with
  EMSGSIZE, silently, so the Tang got nothing. The image now sets
  `spidev.bufsiz=65536`, and the player logs the first write error. The health check,
  which counts frames that reached SPI, caught this.
- **The baked hostname.** It made avahi advertise `ledmapper.local`, which would have
  broken the rig's `splanc-max-2.local` addressing. Now the hostname comes from
  /var/lib/sbc (see "Device state").
- **The health service lost its first sample** across ticks; now the caller carries
  it.

**U-Boot under QEMU.** Before deploying the trial U-Boot to hardware, it was run under
QEMU `raspi3b` against a two-partition SD image. The flag `1 abcd` became `0 abcd`;
`0 …` and an absent flag were left alone.
