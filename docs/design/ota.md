# Firmware updates over the air (split loader + app)

Status: implemented (PR "OTA: split loader + app"). HITL results at the end.

A Splanc C6 player updates over Wi-Fi from the web app, the agent
(`update_firmware`) or the bridge. A small **loader** in the factory slot owns
updates and recovery. The **app** (the player) never writes an image itself. A new
app has to prove itself healthy before it is kept, and if it can't, the device
falls back to the loader, which stays on the network to take another image.
Existing devices need **one** USB flash to get the new layout, and it keeps their
Wi-Fi credentials, TLS identity and stored map.

## Constraints that set the design

**Flash is 4 MB.** All five C6 DUTs on the HITL rigs report `ESP32-C6FH4 (QFN32)`
with `Detected flash size: 4MB` (`esptool flash_id`, 2026-10-21: c6-003f08,
c6-123170, c6-2ce684, c6-117d10, c6-fa3304). The FH4 is the SuperMini's chip, with
4 MB of in-package flash. A DevKitC-1-N8 has 8 MB, but the design has to fit the
boards people actually use. The loader logs the size it reads from the chip at
boot (`esp_flash_get_size`, `[loader] boot … flash=4096K`).

**Measured image sizes** (`-c opt`, this branch):

| Image | Bytes | Notes |
|---|---|---|
| app (`esp32c6_netstack.bin`) | 2,157,392 | the player at main + #311 + the sensor core + OTA (2026-10-22) |
| loader (`esp32c6_loader.bin`) | 1,278,896 | netstack + TLS 1.2 + littlefs + OTA, **no BLE** |

The loader is big because the Wi-Fi path needs the vendor Wi-Fi/PHY blobs
(≈220 KB of `ieee80211`/`pm`/`wpa`/… text), mbedtls with TLS and x509 (≈290 KB),
plus the Arduino/IDF core. Dropping the player itself (FX VM, JIT, keypoints,
micropb, LED drivers) saves only ≈500 KB.

**The loader has no BLE.** The BLE controller and heapless host cost ≈250 KB
(1,548,624 B with BLE). That space buys littlefs room for a 2048-LED map
(#335: the upload peaks at ≈245 KB) and keeps app headroom.

What the loader gives up is BLE Improv provisioning *while in recovery*. It
still has Wi-Fi:

- the credentials the app persisted (#311);
- the wired console's `PROV <ssid> <pass>` line.

The app does BLE provisioning as before. The case that now needs USB is narrow:
the app is broken, **and** the stored Wi-Fi network is gone.

**Two OTA slots don't fit:** 2 × 2.08 MB is more than the 3 MB the legacy table
gives apps. **A Wi-Fi loader plus one app slot doesn't fit in that 3 MB either**
(1.28 + 2.16 = 3.44 MB, and 1.55 + 2.16 with BLE). The only partition that can give room is littlefs, which
the legacy table sizes at 896 KB and which holds well under 100 KB in practice: a
512-LED map is about 20 KB, plus the topology, the effect (≤ 4 KB), the TLS
identity (1 KB), the colour LUT (1 KB) and keypoints. The 64 KB coredump partition
is unused on the C6.

## Flash layout

| Partition | Type | Legacy (huge_app) | OTA layout | |
|---|---|---|---|---|
| bootloader | — | 0x0 | 0x0 | unchanged binary (prebuilt IDF, app rollback **enabled**) |
| table | — | 0x8000 | 0x8000 | `firmware/loader/partitions_ota.csv` |
| nvs | data/nvs | 0x9000, 20K | 0x9000, 20K | **unchanged**: Wi-Fi creds (#311), name, LED config |
| otadata | data/ota | 0xe000, 8K | 0xe000, 8K | unchanged offset; bundles write it **erased** |
| loader | app/factory | — | 0x10000, **1344K** | 1,278,896 B image: 95 KB spare |
| spiffs (littlefs) | data/spiffs | 0x310000, 896K | **0x160000, 384K** | moved and shrunk, migrated by the loader; holds a 2048-LED map + topology upload (~245 KB peak) |
| app | app/ota_0 | 0x10000, 3072K | **0x1C0000, 2304K** | 2,157,392 B image: 197 KB spare (8.5 %) |
| coredump | data/coredump | 0x3F0000, 64K | — | dropped (unused) |

The table binary comes from `firmware/loader/gen_partitions.py`, which is
byte-identical to ESP-IDF's `gen_esp32part.py` for this CSV and for `huge_app.csv`.
`//firmware/loader:layout_test` holds the line:

- the loader fits with ≥ 16 KB spare;
- the app fits with ≥ 64 KB spare;
- nvs and otadata never move;
- loader + littlefs sit entirely below the legacy littlefs region (needed by the
  migration, below);
- an installed app always covers the legacy littlefs superblock.

## Roles and boot flow

The stock IDF bootloader boots `app` when otadata selects it, and `loader`
(factory) otherwise. App rollback is enabled in the prebuilt bootloader
(`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`): an app selected by
`esp_ota_set_boot_partition` boots **pending verify**, and if it resets before it
marks itself valid, the bootloader marks it **aborted** and boots the loader. This
is the same mechanism the swarm loader uses.

```
loader (firmware/loader/loader_main.cpp), every boot:
  0. littlefs: mount; first boot after the USB migration -> copy the legacy fs (below)
  1. decide (firmware/ota boot.rs loader_decide, host-tested):
       resume record in NVS (a transfer in progress)      -> recovery "incomplete"
       app handed over (NVS handoff): update / stay / crash loop -> recovery
       slot has no valid image                            -> recovery "no_app"
       app aborted/invalid (rolled back):
           power-on/brownout/external reset and retry unused -> boot it once more
           otherwise                                       -> recovery "rolled_back"
       else                                                -> select the app, restart
  2. recovery: join Wi-Fi with the stored credentials (NVS "ledmapper"/ssid,pass,
     #311's keys; no BLE: a wired PROV line also works), serve wss:443 with the device's
     own TLS identity (littlefs /lfs/tls_id.bin), answer mDNS (_splanc._tcp, TXT
     mode=loader), take an image (ota_begin/ota_chunk/ota_finish).
     Reason "update" returns to the app after 5 min with no session, or 30 s after
     a refused offer.

app (firmware/player_app/ota_app.cpp):
  boot: crash-loop guard (RTC no-init counter of consecutive panic/WDT resets;
        3 -> hand over to the loader, reason crash_loop). Pending verify -> arm the
        RTC (LP) watchdog for 150 s; Arduino's verifyRollbackLater() returns true,
        so nothing is marked valid at boot.
  loop: health (boot.rs health): up >= 20 s AND render task ticking AND TLS identity
        ready AND (DHCP lease, if the loader itself had one when it booted us)
        -> esp_ota_mark_app_valid_cancel_rollback(), disarm the watchdog,
           NVS last_result="ok".
        Not healthy by 120 s -> esp_ota_mark_app_invalid_rollback_and_reboot().
        Wedged too hard to do even that -> the watchdog resets at 150 s, and the
        bootloader rolls back.
  ota_begin: check the manifest's shape, size and version order, write NVS
        handoff=update, reply STATE_REBOOTING, select the factory app, restart.
```

The network health check only counts when the loader was on the network when it
booted the app (NVS `net`). An AP that is down during an update must not roll back
a good image.

### Keeping the IP across the handoff

Since #326 the netstack joins with the chip's **factory** Wi-Fi MAC, and clears any
stale association on rejoin. The AP's DHCP server leases by MAC, so the IP survives
every restart: the app → loader handoff, an install, and a power cut. Before every
**planned** restart (the handoff, booting an installed app, `ota_reboot`, the idle
return), `netstack_prepare_restart()` also sends the AP a Deauth (reason 3). The AP
then drops the association before the same MAC comes back.

### State (NVS namespace `splanc_ota`)

| Key | Written by | Meaning |
|---|---|---|
| `job` | loader | resume record: the 108-byte manifest + the persisted offset (112 B) |
| `handoff` | app | why the app restarted into the loader (1 update, 2 stay, 3 crash loop); one-shot |
| `app_ver`, `app_size`, `app_sha` | loader | the installed image's manifest version, size and digest |
| `pending` | loader / app | version installed but not yet proven healthy |
| `retry` | loader | the one power-loss retry was used |
| `net` | loader | the loader had a lease when it booted the app |
| `last` | both | `installed` → `ok` / `rolled_back` / `verify_failed` |
| `ldr_ver` | loader | the loader's version, so the app can report it |
| `kepoch`, `krevoked` | loader | accepted key epoch and revoked key ids, never lowered ("Key rotation") |
| `sfloor` | loader | security-version floor, raised at every install |

The app reports `app_version` only while the slot still holds the image the loader
recorded. It re-hashes the slot once, lazily, so after a USB flash the version
reads as unknown (0).

## Image, manifest and signature

The manifest is **byte-for-byte the swarm loader's** (`swarm/net/src/manifest.rs`
in indoor_localization):

| off | size | field | |
|---|---|---|---|
| 0 | 4 | version | u32 LE: `major·10⁶ + minor·10³ + patch` (1.9.0 → 1009000) |
| 4 | 4 | size | image bytes |
| 8 | 32 | sha256 | of the image |
| 40 | 4 | flags | bit 0 = loader image (reserved: refused for now) |
| 44 | 64 | signature | ECDSA P-256 r‖s over SHA-256 of bytes 0..44 |

A release's **`.ota`** package is this manifest followed by the image.

**Checks:**

- The **loader** is the authority. It verifies the signature with mbedtls (the C6's
  ECDSA-verify and SHA accelerators) against the key compiled into it
  (`ota_key.h`, generated from `firmware/ota/keys/*.pub`).
- At boot the loader runs a known-answer test (`ota_kat.h`: a good signature must
  verify and a flipped bit must not). `sign_test` pins that file to the signer's
  output.
- Before the first erase, the loader checks the image header in chunk 0: magic,
  chip id 0x000D (C6), appended SHA, app descriptor.
- After the last chunk, the loader reads the whole slot back through SHA-256 and
  compares it with the signed digest, then runs `esp_image_verify`.
- The **app** checks only the manifest's shape, size and version order. It holds
  no key, so test images don't need a second app build, and a bad signature costs
  one round trip through the loader, which refuses it and returns to the app.

**Flags:** the manifest's `flags` carry the signing **key id** (bits 8–15) and a
**security version** (bits 16–23). Both are inside the signed bytes. Key id 0 at
security version 0 is flags 0, the swarm's default, so the 108-byte layout is
unchanged.

## Signing

**The release key.** The private key is the **`OTA_SIGNING_KEY` repository
secret**:

- Where it lives: Settings → Secrets and variables → Actions → *Repository
  secrets*. It is not an environment secret; the `firmware` job in
  `.github/workflows/release.yaml` has no `environment:`.
- Format: the raw P-256 **private scalar as 64 lowercase hex characters**, exactly
  the `private` line that keygen prints. Not PEM, not DER.
- Generate it with:

  ```
  bazel run //firmware/ota:ota_sign -- keygen
  ```

  The output is two lines:

  ```
  private (OTA_SIGNING_KEY secret): <64 hex chars>
  public  (firmware/ota/keys/release.pub): 04<128 hex chars>
  ```

The public half is committed as `firmware/ota/keys/release.pub`: the SEC1
uncompressed point as 130 hex characters, with optional `#` comment lines. Both
`ota_sign pubkey` and `ota_sign check-pub` print that same format, and
`//firmware/ota:sign_test` checks the committed key parses as a P-256 point in that
form.

**What the release workflow does:**

1. Builds the OTA bundle and the signer.
2. **Fails loudly** unless `ota_sign pubkey --key-env OTA_SIGNING_KEY` equals
   `ota_sign check-pub --in firmware/ota/keys/release.pub`. A wrong secret would
   sign images that every loader refuses.
3. Signs with key id 0 (`tools/ota_release.py`, `--security-version` defaults to 0).
4. Publishes `esp32c6-netstack-<ver>.ota`, `esp32c6-ota-<ver>.tar` and, when
   `firmware/ota/keys/epoch.bin` exists, `key-epoch.bin`.

**Test keys:** `keys/test.key` (id 0) and `keys/test_backup.key` (id 1) are
checked in and public. They sign HITL and development images for loaders built
with `--//firmware/ota:trust=test` or the `*_testkey` targets. Never ship a
test-trust loader.

**Dev builds:** sign with the test keys, or keep flashing over USB.

**Signer subcommands** (`bazel run //firmware/ota:ota_sign -- …`):

- `keygen`
- `pubkey`
- `check-pub`
- `sign --key-id N --security-version S`
- `verify --ring 0=release.pub,1=backup.pub`
- `epoch --epoch E --revoke IDS --key-id SIGNER`
- `verify-epoch --ring …`
- `corrupt`

It uses pure-Rust P-256 (RFC 6979 deterministic signatures).

## Key rotation

**The keyring.** The loader compiles in a small keyring (`gen_key_header.py` →
`ota_key::kRing`):

| id | name | file | role |
|---|---|---|---|
| 0 | `release` | `keys/release.pub` | online: the `OTA_SIGNING_KEY` secret signs every release |
| 1 | `backup` | `keys/backup.pub` | **offline**, in cold storage; signs key-epoch records (and images, in an emergency) |
| 2 | `next` | `keys/next.pub` | a planned successor, committed one loader release before CI switches to it |

An `UNSET` entry verifies nothing. A manifest names its key id, and the loader
verifies it against **that key only**. The id has to be in the ring and must not
be revoked; otherwise the loader refuses with `unknown_key` or `revoked_key`.

**Key epochs.** A key-epoch record is 80 bytes: magic, an `epoch` number, a
`revoked` bitmask of key ids, and the signer's key id, followed by ECDSA r‖s over
those 16 bytes. Any trusted, unrevoked ring key can sign one. Clients send the
newest record they have in `ota_begin.key_epoch`. The release asset
`key-epoch.bin` is fetched by `update_firmware`, and the web app reads it from the
bundle.

The loader accepts a record only if:

- its epoch is above the stored epoch;
- its revocations include every revocation already stored (they never shrink);
- it doesn't revoke its own signer;
- its signer isn't already revoked.

It then persists `kepoch` / `krevoked` in NVS (namespace `splanc_ota`). An older
or equal epoch is ignored. Neither value is ever lowered, and an NVS erase (USB
`--erase-fs`) is the only reset. `ota_status` reports `key_epoch`,
`revoked_keys` and `security_floor`.

**Anti-rollback:**

- **The version check is not a security boundary.** It refuses a lower manifest
  version unless `allow_downgrade` is set, but the client sets that flag, and so
  could anyone on the LAN replaying an old, validly signed image.
- **The security floor is the boundary.** The loader keeps `sfloor`, the highest
  security version it has installed, raised at every successful install, and
  refuses any image below it (`security_floor`) whatever `allow_downgrade` says.
- **Releases raise the security version** (`ota_release.py --security-version
  N`) when they fix a vulnerability. Installing that release makes every older
  release uninstallable over the air on that device. A USB flash still works:
  physical access is trusted.

### Runbook: planned rotation (`release` → `next`)

1. Generate the successor offline: `ota_sign keygen`. Commit its public half as
   `keys/next.pub`.
2. Ship a firmware release. The next migration (USB), or future loader
   self-update, puts the new keyring on devices. **Today the loader changes only
   over USB**, so in practice step 2 rides on the next USB migration. Until
   then, devices keep trusting only `release` + `backup`.
3. Once every device that matters runs a loader that has `next`:
   - In the repo, swap the roles: the new key becomes `release.pub`, the old one
     moves out.
   - Point the `OTA_SIGNING_KEY` secret at the new private key.
   - Optionally, sign an epoch (with the old release key or the backup) that
     revokes the old id, and commit it as `keys/epoch.bin`.
4. Destroy the old private key.

### Runbook: the release key is compromised

1. **Take the backup key out of cold storage.** On an offline machine:

   ```
   ota_sign epoch --key-file backup.key --key-id 1 --epoch <stored+1> --revoke 0 --out epoch.bin
   ```

   Then check it: `ota_sign verify-epoch --ring 0=keys/release.pub,1=keys/backup.pub --in epoch.bin`.
2. **Commit `epoch.bin` as `firmware/ota/keys/epoch.bin`.** Every release now ships
   it as `key-epoch.bin`, and every client sends it with `ota_begin`. Each device
   applies it at its next update attempt, and from then on refuses anything
   signed by the stolen key. A device that never gets an update attempt stays
   exposed; push an update to all of them (`update_firmware {players: "all"}`).
3. **Generate a new release key** (`keygen`). Put its private half in
   `OTA_SIGNING_KEY` and commit its public half as the new `keys/next.pub`.
4. **Bridge releases:**
   - Until loaders carry the new key, sign releases with the **backup** key
     (`ota_sign sign --key-id 1`, by hand on the offline machine), so revoked
     devices can still be updated.
   - The next USB migration ships a loader with the new key, after which CI signs
     with it (a planned rotation).
5. Put the backup key back in cold storage.

**What the owner must do now:**

1. Generate the offline backup key on a machine that will never hold the online
   secret: `bazel run //firmware/ota:ota_sign -- keygen`.
2. Store the **private** line offline (paper or hardware, never in the repo or CI).
3. Send only the **public** line. It gets committed as `firmware/ota/keys/backup.pub`.

Until then, the backup slot is `UNSET` and a compromise of `release` can only be
answered by a USB re-flash with a new loader.

### Loader self-update: not implemented (USB only)

Keyring changes, and any loader change, need a USB flash today. Here is why
updating the loader over the air isn't safe in this layout:

- **Only the app can write it.** The loader can't overwrite the factory slot
  while running from it, so the app would erase and rewrite the 1.5 MB factory
  partition (≈10–15 s of erase + program).
- **A power cut in that window leaves no valid loader.** The app still boots
  (otadata selects it), but any later crash or rollback lands on an invalid
  factory image and the device needs USB. There is no second loader copy to fall
  back to: flash is full, with 95 KB spare in the loader slot.
- **A bad loader has the same effect,** even when correctly signed.
- **What a safe version would take:** an A/B loader pair. That doesn't fit in
  4 MB next to a 2.2 MB app slot. An alternative is a tiny immutable first stage
  that picks between two loader images, which would also have to fit.
  `FLAG_LOADER` stays reserved and refused until then, so a loader image can't be
  installed by accident.

## Transport (player protocol, `ledmapper.proto`)

| ClientMessage | # | | ServerMessage | # |
|---|---|---|---|---|
| ota_begin{manifest, allow_downgrade} | 50 | | ota_status | 28 |
| ota_chunk{offset, data ≤ 4096} | 51 | | | |
| ota_finish | 52 | | Welcome.ota (loader only) | 16 |
| ota_abort | 53 | | | |
| get_ota_status | 54 | | | |
| ota_reboot{TARGET_APP / TARGET_LOADER} | 55 | | | |

These numbers skip 46–47 and 25–26 (reserved for FUG-82) and 48–49 and 27 (the
sensor core, #315).

**Flow:**

1. `ota_begin` to the app gets `REBOOTING`.
2. The client reconnects to the loader (its welcome has `ota.mode = MODE_LOADER`
   and features `ota, loader, tls_info`).
3. `ota_begin` again gets `RECEIVING` plus `offset`.
4. Each `ota_chunk` gets `ota_status` with the next offset (stop-and-wait, one TLS
   record per chunk).
5. `ota_finish` gets `INSTALLED`; the device boots the app.
6. `get_ota_status` reports `last_result` (`ok` or `rolled_back`).

**Resume:** progress is persisted every 64 KB and at the end. `ota_begin` with the
same manifest resumes at the persisted offset rounded down to a sector. That
sector is erased again, so a half-programmed sector never survives into the image
(`session.rs`; every cut point is exercised on a simulated NOR flash in
`ota_test`).

**Throughput:** 4 KB chunks. Each chunk costs one RTT plus a ≈40 ms sector erase
and a 4 KB program. See the HITL numbers for the rig's tunnelled path.

**Other requests:** the loader also answers `hello`, `time_sync_ping` and
`get_tls_info`, so a stock client's connect sequence completes. Every other arm
gets `error{unsupported}`. The loader decodes ClientMessage by hand
(`firmware/ota/src/wire.rs`), and `wire_test` checks every field number against
the generated host bindings.

**Pull from GitHub:** the loader doesn't fetch images itself. The netstack has no
TLS client, so a pull through `https://splanc.pages.dev/gh-asset` would need one.
Clients push instead, which works from a phone, a laptop, the agent and the
bridge.

## UX

- **Web app, Flash screen:** when the connected device advertises `ota` (or sits
  in its updater), the screen offers **"Update ⟨name⟩ over Wi-Fi"** above the USB
  flash. It needs no Web Serial, so it also works on iOS and Android. Progress
  shows handoff, transfer %, verify, reboot and the health check.
- **Device in the updater:** the connection pill reads "in updater" and a toast
  points to the Flash screen.
- **Package source:** the `.ota` comes from the release bundle
  `esp32c6-ota-<ver>.tar`, which carries it inside, or from a cached copy for
  offline use.
- **Driver:** `web/src/net/otaUpdate.ts`, shared with the agent.
- **Agent:** `update_firmware {version: "latest" | X.Y.Z, allow_downgrade?, players}`
  fetches the release's `.ota` (`esp32c6-netstack-<ver>.ota`). For development,
  set `SPLANC_OTA_PACKAGE=path`. It rolls out **canary-first**: one player alone,
  and the rest in parallel only if it came back healthy. This is the swarm's canary
  rule turned into a rollout policy. It reports MCP progress
  (`notifications/progress`) per phase and per 10 %.
- **Bridge:** it hosts the same MCP server, so `update_firmware {players: "all"}`
  updates every fixture.

## One-time migration (USB, from the legacy layout)

The new app slot covers the old littlefs region (0x310000–0x3F0000), so a single
write of all five images would destroy the user's maps and TLS identity before
anything could copy them. The migration runs in **two phases**:

1. Write everything **below** the app slot: bootloader, table, **erased otadata**,
   loader. Nothing at or after 0x1C0000 is touched, so the old filesystem is
   intact.
2. Reset. The loader boots first (otadata is erased) and, on its first boot:
   - formats the new littlefs at 0x160000;
   - mounts the old region read-only through a hand-made partition view (it
     overlaps `app`, so it can't be registered);
   - copies every file across (temp files skipped);
   - writes `/lfs/.ota_migrated`;
   - logs `[loader] migrate: done legacy=1 copied=N failed=0`.

   Until the marker exists, every boot redoes the copy from a fresh format, so a
   power cut mid-copy just starts over.
3. Write the app (phase 2). The loader finds a valid app and boots it. NVS (Wi-Fi
   credentials from #311) was never touched.

**Who runs it:**

- The **web flasher** reads the board's partition table first. A table without a
  factory `loader` means the legacy layout, and it runs the two phases. Between
  them it waits `wait_seconds`, reconnects to the ROM, and refuses to write the
  app unless the new littlefs superblock exists. If the loader never ran, the
  user's data is still in the old location.
- A board that already has the OTA layout takes a plain single-phase write.
- The bundle's `flash.json` carries an `ota` block (`app_offset`,
  `legacy_migration.phase1_below`, `wait_seconds`, `package`).
- **Release assets:**
  - `esp32c6-ota-<ver>.tar` is the new layout. Older web apps don't match that
    name, so they can't single-phase it by accident.
  - `esp32c6-netstack-<ver>.tar` is still published in the legacy layout. That
    app runs and answers `get_ota_status` with `error=legacy_layout`.

## Testing

**Host tests** (all in `bazel test //...`):

- `//firmware/ota:ota_test` covers:
  - SHA-256 known answers;
  - the manifest layout;
  - the image-header gate;
  - offer checks;
  - ordering and erase planning;
  - persist cadence;
  - every power-cut point resuming to the exact image on a simulated NOR flash;
  - the loader decision table;
  - the crash-loop counter;
  - the health verdicts.
- `:wire_test` checks the hand codec against the generated bindings.
- `:sign_test` uses real P-256: sign, verify, tampering, wrong key, and KAT drift.
- `//firmware/loader:layout_test` holds the size and layout invariants above.
- `//web:otaUpdate_test` and `//pi/hitl/tests:hitl_test` (`test_ota_core.py`) run
  the web and Python drivers against a simulated device: handoff, reset mid-stream
  and resume, rollback, bad signature, legacy layout.
- `//web:partitionTable_test` and `//agent:firmware_test` cover table parsing,
  package resolution and the canary rollout.

**HITL gate** (`//pi/hitl/harness:ota_gate`, tag `hitl`, one reservation):

1. **migrate:** legacy bundle, provision, upload a 120-LED map, read the cert pin,
   then the two-phase USB migration. The device must rejoin with no provisioning,
   with the same cert and the same stored map bytes.
2. **upgrade:** A → B, which reports `+b`.
3. **crash:** an image that aborts at boot rolls back; B over the air recovers it.
4. **unhealthy:** an image with no render task fails health at 120 s and rolls
   back; B recovers it.
5. **powercut:** a chip reset half way through the transfer, then resume and
   verify. The rig can reset a DUT over USB but can't cut its power. The reset
   aborts the flash write the same way, and its reset reason is external, like a
   power-on.
6. **badsig:** one flipped signature bit is refused (`bad_signature`), and the
   device returns to its app.

Every image is signed with the test key, for the test-key loader.

## Convergence with the swarm loader

| Concept | swarm (indoor_localization) | Splanc |
|---|---|---|
| Who owns updates | `loader` factory app | same |
| App slot | `main` ota_0 | `app` ota_0 |
| Rollback | IDF app rollback; RTC watchdog health deadline; canary rule | same mechanisms; health = render + TLS (+ net); canary-first rollout in the agent |
| Manifest | 108 B, ECDSA P-256 over SHA-256 of 44 B | **identical** (per-product keys) |
| Staging | separate `staging` partition (the image is ≈450 KB) | none: 4 MB can't hold a second 2 MB copy, so the loader writes the slot directly and recovery *is* the loader |
| Transport | UWB pages (Deluge-style) + serial push | wss, stop-and-wait chunks |
| Crash-loop after validation | open item in its WORKLOG | implemented (RTC counter → loader) |
| Loader self-update | reserved (FLAG_LOADER) | reserved, refused |

The core (`firmware/ota`: manifest, session, boot decisions, health) is no_std,
dependency-free Rust, so a future swarm-plus-splanc loader can share it, as the
swarm's `swarm/net` is shared today. Its transports sit on top of the same
manifest and boot decisions.

## Limitations and follow-ups

- **Loader updates** are USB-only. They need their own anti-brick story (a bad
  loader has no recovery).
- **Post-validation hangs** become a counted reset only if a watchdog fires; the
  task WDT watches the idle task, not the loop task.
- **No true power-cut on the rig:** the reset test stands in for it.
- **littlefs is 192 KB** (was 896 KB). That is enough for today's data, but an
  on-device effect library would need flash that a 4 MB part doesn't have.
- **The OTA client is single-session per device.** An update holds the device's
  wss slot for its duration.

## HITL results

`//pi/hitl/harness:ota_gate`, every phase in one reservation on rig-2 / c6-003f08
(ESP32-C6FH4, 4 MB).

**Run 8, 2026-10-22: verdict PASS.** Layout loader 1344K / littlefs 384K / app
2304K, rebased on main (#311, #326 factory MAC, the sensor core), 512-LED map.

| phase | result | numbers |
|---|---|---|
| migrate (USB, two phases) | PASS | loader copied 3 littlefs files (512-LED map, topology, TLS identity); rejoined Wi-Fi with no provisioning; same TLS cert pin; same map, byte-identical |
| upgrade A→B | PASS | 96 s total: handoff 31 s, 2.16 MB in 36 s (58 KiB/s through the rig tunnel), verify 0.6 s, boot 28 s, healthy at 20 s uptime; runs `+b`, map kept |
| crash at boot | PASS | the bootloader rolled it back to the loader; B over the air recovered it (66 s) |
| never healthy | PASS | the health check rolled it back at 120 s (202 s total); B recovered it |
| reset mid-transfer | PASS | chip reset at 1.08 MB. The AP never answered auth for the factory MAC, so after 12 s the netstack fell back to a random MAC (new lease). The loader resumed at 1,048,576, verified and booted; the app came back on the factory MAC and its usual IP |
| bad signature | PASS | refused (`bad_signature`), nothing written, the device returned to its app |
| key rotation | PASS | image signed by the (test) backup key with an epoch revoking the release key: installed; then a release-key image refused (`revoked_key`); status reports epoch 1 / revoked 0x1 |

Run 6 (2026-10-21, previous layout 1600K / 192K / 2240K, BLE in the loader) also
passed every phase.

**MAC fallback (netstack).** After an *unplanned* reset in the middle of traffic,
the rig AP kept the stale association for the factory MAC. #326's deauth didn't
clear it, and authentication went unanswered for minutes. The netstack now falls
back to a random locally administered MAC after 12 s of unanswered auth. That
costs one new lease (mDNS re-announces); without it the device would be
unreachable. Planned restarts deauth first and keep the factory MAC and its IP.
