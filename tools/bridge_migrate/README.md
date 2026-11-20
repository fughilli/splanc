# Move a Splanc Pi bridge to a new card without pairing again

Writing a new bridge image onto a card normally starts the bridge from scratch: it gets a new
identity, and every app and agent that was paired with it has to pair again. That is the only way
onto system updates for bridges written before over-the-air system updates existed
(pi-bridge-v1.0.0 and v1.0.1, October 2026; OTA arrived with pi-bridge-v1.1.0). `bridge_migrate.py`
copies the old bridge's identity and settings and puts them on the new card, so the new bridge
comes back **as the same bridge, still paired**.

You need: a computer (Mac or Linux) with Python 3 and `ssh` (both come with macOS), the
[Splanc Bridge Flasher](../../docs/pi-bridge.md#1-get-the-splanc-bridge-flasher), and **a second
micro-SD card**. The old card is your way back if anything goes wrong, so don't overwrite it.

Get the script: it is a single file with no dependencies,
[`tools/bridge_migrate/bridge_migrate.py`](bridge_migrate.py). Download it (or clone the
repository) and run it with `python3`. The commands below assume it's in your current folder.

## Steps

### 1. Let your computer log into the old bridge

The old image has no password login. It accepts an SSH key that's on its card, so the first step
puts one there.

1. Unplug the bridge, take its card out and put it in your computer. Its boot volume appears (on a
   Mac: `/Volumes/FIRMWARE`).
2. Run:

   ```sh
   python3 bridge_migrate.py enable-ssh
   ```

   This creates an SSH key just for this tool (in `~/.config/splanc-bridge-migrate/`) and writes
   its public half to the card's `authorized_keys`. Nothing else on the card changes.

3. Eject the card, put it back in the bridge and power it on. Wait until its screen shows the
   status again (about two minutes).

### 2. Back up the old bridge

```sh
python3 bridge_migrate.py backup --ssh splanc-bridge.local
```

(Use the bridge's name if you renamed it, or its IP address.) This:

- logs in, reads the bridge's status and checks the **must-keep** items (below). If one is
  missing or doesn't match, it stops and says why. It never saves a backup that can't restore the
  pairing without telling you.
- **stops the bridge** on the old Pi, so nothing changes after the copy (its screen says "Waiting
  for bridge"). Your fixtures keep playing; only remote control through the bridge pauses.
- writes the backup to `~/splanc-bridge-backup/splanc-bridge-<bridge id>-<date>.tar.gz`, readable
  only by you, then reads it back and checks every file's checksum.

**Unplug the old bridge now and keep its card as it is.** Two bridges with the same identity
would keep taking the connection from each other.

To see what was saved (passwords and keys are never shown):

```sh
python3 bridge_migrate.py inspect ~/splanc-bridge-backup/splanc-bridge-*.tar.gz
```

### 3. Write the new card

1. Put the **new** card in your computer and write it with the Splanc Bridge Flasher as usual
   (pick the newest image, enter your Wi-Fi). Don't boot it yet.
2. When the flasher is done, leave the card in (or put it back in) and run:

   ```sh
   python3 bridge_migrate.py restore ~/splanc-bridge-backup/splanc-bridge-<...>.tar.gz
   ```

   It writes onto the new card's boot volume:

   - `splanc-restore/`: the bridge identity and state. Bridge images newer than pi-bridge-v1.2.0
     import it on their first boot, before the bridge starts, and then delete it from the card.
   - your other saved Wi-Fi networks from the old bridge (the one you entered in the flasher wins
     if it's the same network);
   - settings from the old card that the flasher didn't set (for example the OLED rotation);
   - the SSH key from step 1 (and any you had on the old bridge), for step 4.

   Add `--dry-run` to see what it would write first.

### 4. Boot the new card and check

Put the new card in the Pi and power it on. After about three minutes (the first boot takes
longer), run:

```sh
python3 bridge_migrate.py restore ~/splanc-bridge-backup/splanc-bridge-<...>.tar.gz --ssh splanc-bridge.local
```

- If the bridge already imported the backup from the card, this only checks.
- If it didn't (pi-bridge-v1.2.0 and older don't know how), this finishes the job over SSH: it
  stops the bridge, puts the identity and state in place (owned by the bridge's user, readable
  only by it), adds the Wi-Fi networks, removes the copy from the card and starts the bridge
  again.

Then it waits until the bridge reports **paired** with its old bridge id and says so. The OLED
shows the same: the bridge is back, your apps and agents work as before.

Afterwards: keep the old card unplugged for a few days, then wipe it. Delete the backup once
you're happy. It contains the bridge's private key and your Wi-Fi passwords.

`python3 bridge_migrate.py verify <backup> --ssh splanc-bridge.local` re-runs the check any time
without changing anything.

## What is kept

| What                                                            | Where on the bridge                                     | Why                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Bridge identity** (Ed25519 key + the relay's bridge id)       | `/var/lib/splanc-bridge/bridge.json`                    | **Must-keep.** It is the pairing (see below).                           |
| Known fixtures, their TLS pins, groups/rooms, poses             | `/var/lib/splanc-bridge/config/hub.json`                | Fixtures reconnect straight away, without being trusted again.          |
| LAN direct endpoint certificate + key                           | `/var/lib/splanc-bridge/live-tls.json`                  | Browsers that accepted the bridge's certificate don't have to again.    |
| LAN tickets (hashes)                                            | `/var/lib/splanc-bridge/live-clients.json`              | Apps keep their direct LAN path (they're re-issued over the relay too). |
| Local effects library                                           | `/var/lib/splanc-bridge/effects-library.json`           | Your saved effects.                                                     |
| Anything else the bridge keeps in its state folder              | `/var/lib/splanc-bridge/...`                            | Future-proof: copied as is.                                             |
| Saved Wi-Fi networks (flasher and phone-app/Improv ones)        | `/etc/NetworkManager/system-connections/*.nmconnection` | Added next to the flasher's network as `restored-...`.                  |
| SSH keys                                                        | `/var/lib/splanc-ssh/authorized_keys`                   | Merged into the new card's `authorized_keys`.                           |
| Card settings (name, Wi-Fi country, relay, OLED, HDMI, updates) | `splanc-bridge.conf` on the boot volume                 | Only keys the flasher didn't set; the flasher's choices win.            |

Not copied, on purpose:

- **The agent software** (`/var/lib/splanc-agent`). The new image brings its own. If a newer one
  is out, the bridge offers it on the Updates screen as always (you confirm on the bridge).
- **SSH host keys, `/etc/machine-id`**: per-machine, made fresh on the new card. The tool keeps a
  separate list of SSH host keys for the old and the new bridge, so the changed key under the same
  name doesn't look like an attack.
- **Update state and logs**: the old image has no system-update state, and logs are kept in RAM.
- Hostname and time zone have no state of their own: the name comes from `splanc-bridge.conf`, the
  time zone is always UTC.

### Why the pairing survives

The relay (`agent/relay`) knows a bridge by the bridge id it handed out when the bridge first
registered its public key. Paired clients' credentials are stored **on the relay**, under that
bridge id. Each time the bridge connects it signs the bridge id and the time with its private key,
and the relay checks the signature against the key it stored. Nothing is tied to the Pi, the card
or an install: there is no per-install nonce. A bridge with the same `bridge.json` is the same
bridge, so restoring the file is all it takes, and nothing has to change on the relay. Clients
paired or revoked after the backup are handled by the relay, so they're right after the restore
too.

Two things the tool checks, because they would break that:

- the backup must have a bridge id **for the relay the bridge uses** (the default
  `https://splanc.pages.dev`, or `SPLANC_RELAY` from the card's settings). The new card gets the
  old card's `SPLANC_RELAY` if the flasher didn't set one.
- the bridge's clock must be right (signatures are only valid for a few minutes). The Pi sets it
  from the network; the check step says so if the bridge can't connect.

## If something goes wrong

- **Any time:** put the **old card** back in the old Pi and power it on. Nothing on it was changed
  except the extra `authorized_keys` file, and it is the same bridge as before. Make sure the new
  one is off.
- **`backup` stopped with a warning:** read it. "unpaired" means no client is paired with this
  bridge (nothing to keep); a relay mismatch means the identity was registered on another relay.
  `--force` saves anyway.
- **`Can't reach splanc-bridge.local over SSH`:** check the Pi is on the same network as your
  computer, wait a minute longer, or use its IP address (shown on the OLED/HDMI).
- **`refused the SSH key`:** the card wasn't prepared before it booted. Re-run `enable-ssh` (old
  card) or `restore` without `--ssh` (new card) with the card in your computer.
- **The new bridge isn't connected:** check its Wi-Fi (use the Splanc app's **Add device over
  Bluetooth** to give it a network) and run `verify` again.
- **"the relay has no paired clients":** the bridge is back with its old identity, but the
  clients were revoked meanwhile. Pair again from the app.
- **On the bridge:** the files the restore replaced are kept in
  `/var/lib/splanc-bridge/pre-restore-<time>/`, and `splanc-restore-result.txt` on the boot volume
  says what the first-boot import did.

## Without SSH: reading the old card directly (Linux)

If the old bridge doesn't boot any more, read its card on a Linux computer. The bridge's files are
on the card's second (ext4) partition, which macOS can't read by itself.

```sh
sudo mkdir -p /mnt/oldbridge
sudo mount -o ro /dev/sdX2 /mnt/oldbridge         # the card's second partition (see lsblk)
sudo python3 bridge_migrate.py backup --from-root /mnt/oldbridge --from-boot /media/$USER/FIRMWARE
sudo umount /mnt/oldbridge
```

`sudo` is needed because the files belong to the bridge's own user; the backup is still saved in
your home folder and owned by you. On a Mac, either use a Linux computer or VM that can see the
card reader, or a read-only ext4 driver (macFUSE + `ext4fuse`, then
`--from-root <its mount point>`). The SSH route above avoids all of this.

## For developers

- Everything runs as fixed shell scripts over `ssh root@<bridge>` (`BatchMode`, the tool's own
  key and known-hosts files). The old images (v1.0.x) have `tar`, `sha256sum`, `mktemp`, `find`,
  `nmcli` and `systemctl` on the path (checked in the pi-bridge-v1.0.1 Pi 5 release image).
- The card format the image imports: `splanc-restore/manifest.json` + `splanc-restore/state/<path>`,
  documented and checked in `pi/bridge/image/splanc_image/bootconfig.py` (`import_restore`):
  plain relative paths only, every size and SHA-256 checked before anything is written,
  `bridge.json` must be a usable identity, all or nothing, owner `splanc`, 0700/0600, replaced
  files kept, the bundle removed from the card afterwards and never imported twice.
- Tests: `bazel test //tools/bridge_migrate:bridge_migrate_test //pi/bridge/image:image_py_test`.
  They run backup → inspect → restore (card and SSH) → verify against fake bridge root folders and
  a fake `ssh` that runs the scripts locally, and the card path end to end through the image's own
  importer.
