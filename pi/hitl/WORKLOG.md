# HITL rig — worklog

Handoff notes alongside git history. Newest first. Read this before touching the
rig's networking — there's live runtime state that isn't fully declarative yet.

## 2026-08-10 — FUG-94: the FUG-61 provisioning flake is a per-connect BLE failure, not coexistence

The FUG-61 fix works; its recorded root cause (WiFi/BLE **coexistence** starves the
first BLE connect) was wrong and was repeated in three places. Re-measured on the
rig (DUT boards `f0:f5:bd:2c:e6:86` / `8c:fd:49:12:31:72`, driven from the container
over the LAN) to settle the mechanism empirically. **Behaviour is unchanged** — this
was a diagnosis exercise, not a behaviour change.

### Method

an experiment-only instrument (`fug94_measure.py`; not committed — this is a
diagnosis, not a shipped tool). Stock firmware flashed `--erase-fs`, so the failing boot has **no
stored creds** → `setup()` runs `WiFi.mode(WIFI_AP_STA)`+`softAP()` unconditionally
but `WiFi.begin()` is gated behind `if (ssid.length() > 0)`, so there is **no STA
association** — only an idle soft-AP beacon (verified: boot banner shows `sta off`,
AP `192.168.4.1`); `improv_ble_begin()` runs last. So the ticket's premise holds:
there is no WiFi association on the failing boot to "coexist" with. Per sample the
instrument hard-resets the DUT, stamps the `[ble] advertising …` serial line (t_adv),
then does a harness-faithful scan+single-connect (`tries=1` — fix disabled) recording
whether the match had a **resolved name**, **ms since advertising start**, connect
latency, and the exact error. Reboot between samples, never writing WiFi settings, so
NVS stays empty and every boot is the erase-fs first-provision state.

Rig time was heavily contended (the neighbouring DUT was held by another reservation
on the **same shared host BLE adapter** throughout — itself relevant to H3, below),
so samples were gathered across many short reservations streamed to a local file.

### Data (Wilson 95% CI)

Every failure is the FUG-61 symptom: a message-less `TimeoutError` at
`BleakClient.connect()`, never reaching `connected=True`.

**Baseline — harness-faithful (discover/8 s scan, `tries=1`), no-creds soft-AP:**

| arm                                         | n   | connect FAIL | rate (95% CI)    | every match named? |
| ------------------------------------------- | --- | ------------ | ---------------- | ------------------ |
| baseline_softap (no creds)                  | 19  | 10           | **53% (32–73%)** | yes (0 name-less)  |
| stored-creds, active STA join (H1 contrast) | 9   | 4            | 44% (19–73%)     | yes (0 name-less)  |

In discover mode every matched advertisement carries a **resolved name** and the
board has been advertising ~8 s (ms_since_adv≈8000) — fully settled — yet ~half
still time out. The stored-creds arm has an **active STA join = maximum WiFi/BLE
coexistence**, and fails no more than the soft-AP-only arm.

**H2 delay sweep — vary time-since-advertising (fast scan, `tries=1`, no-creds), n=28:**

| pre-connect delay | n   | connect FAIL | rate (95% CI) |
| ----------------- | --- | ------------ | ------------- |
| 0 ms              | 6   | 3            | 50% (19–81%)  |
| 500 ms            | 6   | 1            | 17% (3–56%)   |
| 1000 ms           | 6   | 4            | 67% (30–90%)  |
| 2000 ms           | 5   | 2            | 40% (12–77%)  |
| 5000 ms           | 5   | 3            | 60% (23–88%)  |

The success rate does **not** rise with settling time — it is flat/non-monotonic
across 0–5 s, and equally flat binned by measured ms_since_adv (`<1.5 s`: 8/19 fail;
`>6 s`: 17/32 fail). A name-less match essentially never happens: the scan-response
name resolved within ~200 ms in **every** sighting (name-less n=0 across all 65).

**Pooled `tries=1` (all first-connect samples): n=65, 32 fail = 49% (37–61%), 0 name-less.**

**Fix confirmation — same no-creds board, discover/8 s, `tries=5` (the FUG-61 retry loop):**

| arm        | n   | RUN FAIL (all 5 tries lost) | rate (95% CI) |
| ---------- | --- | --------------------------- | ------------- |
| fix_tries5 | 4   | 0                           | 0% (0–49%)    |

With each try failing ~independently ~50%, five tries predict a run-level failure of
~0.5⁵ ≈ 3% — consistent with 0/4 observed. Rapid same-boot retries ride out the
per-attempt failure; that is exactly what the fix does and why it works. (n=4 here is
thin — the fix arm is expensive per sample; but the mechanism is nailed by the
`tries=1` data above.)

### Which hypothesis the evidence supports

- **H2 (peripheral readiness / name-less early-pounce) — RULED OUT.** Failure rate is
  independent of time-since-advertising (flat across the delay sweep and the
  ms_since_adv bins) and of whether the name had resolved (it always had; 0/65
  name-less). A readiness/early-pounce race predicts the opposite. So the connect
  failure is not H2.
- **H1 (WiFi/BLE coexistence) — RULED OUT as written.** There is no WiFi association
  on the failing boot to contend with — only an idle soft-AP. And more WiFi activity
  does not raise the rate: the active-STA arm (44%) failed no more than soft-AP-only
  (53%), overlapping CIs. The dedicated WiFi-_off_ firmware arm (Arm B) was not run
  (needs an uncontended window to reflash a variant), but the stored-vs-no-creds
  contrast already settles it: the failure is not "coexistence bring-up during
  association."
- **H3 (central-side / BlueZ / shared adapter) — the leading candidate, unconfirmed.**
  The failure is a **transient, ~per-attempt-independent** connection-establishment
  timeout (~0.5 each), which is exactly why _rapid_ retries within one boot work
  (≈0.5^tries) while reboot-gated single tries don't (a reboot re-rolls the same
  coin). The rig's BLE radio is a **single shared host adapter, not isolated per DUT**
  (DESIGN.md open item), and the neighbouring DUT was held by another reservation
  scanning/connecting on that same host `bluetoothd` throughout — a live contention
  source consistent with the signature. Distinguishing "peripheral never answers
  CONNECT_IND" from "central never issues / BlueZ stalls on the shared adapter" needs
  a link-level HCI/btmon capture inside the reservation (**FUG-93**, not yet landed) —
  the outstanding packet-level check.

### Which half of the fix is load-bearing

The **`_connect` rapid-retry loop** (`hitl_improv._connect`, `tries>1`) — the OPPOSITE
of the ticket's H2-wins hypothesis. Because the per-attempt failures are ~independent
at ~50%, retrying within one boot drives the compound failure to ≈0.5^tries (five
tries → ~3%, observed 0/4). The `find()` **name-wait gate** is cheap defence-in-depth
(avoids pouncing on a half-advertised board), **not** the deflaker — a name-less match
does not predict connect failure. Keep both; the docstrings now say so, and
`pi/hitl/tests/test_improv_find.py` guards both (retry default stays > 1; the name gate
never hands a name-less advertisement to the connect path un-waited) so neither is
"simplified" away on the wrong premise.

### Bottom line

The flake is a **transient, per-attempt BLE connection-establishment failure on a
freshly-booted C6** (~50% per connect, n=65), independent of advertising-settle time
and of any WiFi association (there is none). **H1 and H2 are ruled out; H3
(shared-adapter / central-side) is strongly indicated but unconfirmed at packet level
(FUG-93).** The coexistence explanation is corrected here, in the 2026-08-05 entry
below, and in the `_connect` / `provision_dut` / `find` docstrings.

## 2026-08-08 — FOLLOW-UP: tighten the FX cost-model estimator (~10% → ~5%)

`fx_bench` now has two tests off one golden (`web/tests/testdata/device-bench-esp32c6.json`):
the on-hardware margin check (fresh run vs golden frame cycles) and the software
estimator test (`web/tests/deviceProfileHardware.test.ts`: fit `buildDeviceProfile`,
validate a held-out spread of real effects). The estimator gate is **13%**, not the
requested 5%, because that's where the current model tops out — this is the
follow-up to close that gap.

Root cause (measured, not guessed — use `FIT_DEBUG=1 bazel run //web:fit_device_profile -- <bundle>`
for the per-program dump): the linear sum-of-independent-op-costs fit
(`web/src/effects/calibrationFit.ts`) **over-predicts the cheapest real effects**
(`empty` +34%, `sweep16` +42%, `neg2M` +14%, held-out `lavalamp` +19%) while every
expensive program lands ±3–7%. It's an absolute-error least-squares, so the huge
programs dominate and the fixed/per-LED overhead is set to fit _them_. Held-out
spread RMS ≈ 9.9% (R² 0.97); `lavalamp` is a ~19% outlier.

Tried and rejected: reweighting the fit toward **relative** error (with a soft
floor, swept the parameter). It lowers the cheap-program in-sample error but makes
**held-out generalization worse** (the tiny `empty`/`sweep` anchors then dominate).
So it's a model-structure ceiling, not a weighting knob. Reverted; production
`calibrationFit.ts` is unchanged.

To actually reach ~5%, the promising directions (each needs rig time to re-measure
the golden — drive it via `hitl_shim`; regenerate with
`fx_bench --emit-golden <the golden path>`):

- Richer features: a fixed per-shade / per-op-issue overhead term, or structural
  features (branch/call counts) the pure opcode histogram misses.
- Non-negative-clamp interaction: the fit clamps costs at 0 (`Math.max(0, x)`),
  which distorts under-determined columns — try a proper NNLS or a better prior.
- Diagnose `lavalamp`'s specific mis-costed opcodes (its histogram vs the fit
  coverage) — it's the lone structural outlier.
- Add isolation microbenchmarks for any op the real effects use but the current
  set under-covers, so the linear fit is better anchored.

The offline loop (`//web:fit_device_profile`, no hardware) makes fit/model
iteration fast; only _new_ microbenchmarks need a rig re-measure.

## 2026-08-05 — deflake e2e provisioning (FUG-61): retry the BLE connect

> **CORRECTION (2026-08-10, FUG-94):** the _fix_ below is correct and stays, but
> the **root-cause explanation in this entry is wrong**. The "single-core C6 shares
> one radio between WiFi and BLE, so the first connect times out during coexistence
> bring-up" story does not hold: on the erase-fs failing boot there is **no WiFi
> association** (WiFi.begin is gated off with no stored creds — only an idle
> soft-AP), so there is no coexistence bring-up to contend with. Re-measurement
> shows the failure is a **transient, per-attempt BLE connection-establishment
> failure** (~50% of first connects), **independent of advertising-settle time and
> of whether the name had resolved** — which rules out the readiness-race reading
> too. The load-bearing half of the fix is therefore the `_connect` **rapid-retry
> loop**, not the `find()` name gate. See the FUG-94 findings entry at the top of
> this file for the arms, n, and confidence intervals.

Looping the e2e against the rig reproduced the CI flake at **20% run-level
failure** (2/10 runs failed outright) with the **first provision attempt failing
~50% of the time**. Every failure was a message-less `TimeoutError:` at the BLE
**connect** — the provisioner log never reached `connected=True`. Root cause: the
single-core C6 shares one radio between WiFi and BLE, so the first `BleakClient`
connect right after a (re)boot routinely times out during coexistence bring-up.

The old `provision_dut` recovery rebooted the DUT and tried the connect **once**
per reboot; with the connect flaking independently each try, a run could lose that
coin-flip on all three reboots (seen twice in ten) — that is the CI "timeout
during provisioning". The CI "attempt 1 saw only the MAC, no name" is the same
early-pounce: the firmware advertises the name in the **scan response** (only the
Improv service UUID rides in the primary ADV, `improv_ble.cpp`), so a name-less
match means the board was caught mid-advertise.

Fix (`pi/hitl/harness`, no rig redeploy — these files are scp'd per run):

- `hitl_improv.py` `_connect()`: retry the connect up to 5× **within one
  attempt** (same boot, no reboot; 12 s each + backoff; tear down half-open links
  between tries). Rapid reconnects ride out the coexistence window far more
  reliably and cheaply than reboot-gated single tries.
- `hitl_improv.py` `find()`: prefer a device advertising a resolved **name**,
  re-scanning briefly for the scan response before falling back to a name-less
  hit — so we connect to a board that's actually up.
- Report the real transport error (`BLE transport failed: …`) instead of the
  bare `TimeoutError:`.
- `provision.py`: widen the per-attempt ssh budget to cover the in-attempt
  retries; the outer reset+retry stays as a last-resort backstop.

Method note (for the next agent reproducing on hardware): run the built binary
directly in a loop rather than `bazel run … | tee | tail` (that pipeline buffers
and can drop the result). Also, `-c opt` vs a stray non-opt `bazel` command flaps
the `bazel-bin` convenience symlink — pin the `aarch64-opt/bin/...` path.

## 2026-08-05 — multiple DUTs per rig (FUG-67)

The queue manager now hands out **N DUTs concurrently**, each its own container +
sshd port + device nodes, from **one shared FIFO** with a per-DUT active slot
(`internal/queue`). `reconcile` fills every free DUT with the earliest compatible
waiter; a reservation can pin a DUT (`ReserveRequest.Device` / `hitl reserve
--device <name>`) or take any free one (default, and what old clients send).

- **Config:** `nix/hitl-app.nix` has a `duts` list (default = the one MVP DUT);
  it generates one `--dut '{"name","ssh_port","devices":["host:container"],"env"}'`
  flag per DUT and opens each port. Each DUT's tty is remapped to `/dev/ttyACM0`
  in-container so `hitl flash/monitor --port` defaults hold everywhere. To add a
  second board: give it a distinct `sshPort` and its stable `/dev/serial/by-id/…`
  path (find with `ls -l /dev/serial/by-id/`), mapped to `:/dev/ttyACM0`.
- **API stayed backward-compatible** — no client rebase. `Status.Active`/
  `queue_length` report the rig idle while _any_ DUT is free (so old clients +
  the pool picker still work); `Status.Devices` is the new per-DUT breakdown.
- **Hardware follow-ups (single shared resources, not yet split per DUT):** JTAG
  raw-USB isolation (all containers see the whole `/dev/bus/usb`; boards are
  selected by `HITL_ADAPTER_SERIAL`, wired into `hitl-jtag`/`hitl-gdb` — set the
  per-DUT `env` and verify openocd's `adapter serial` picks the right C6 on real
  hardware); one BT radio shared for BLE; rig-level provisioning AP. Filed as
  follow-ups if the humans want them tracked.
- Verified: `bazel test //pi/hitl/...` (queue routing/concurrency/pin, Status
  compat, `--dut` parsing, pool packing). Not run on real multi-DUT hardware yet.

## 2026-08-03 — self-hosted provisioning AP (+ tag discovery, CLI-driven e2e)

### What this adds

The rig hosts **its own WiFi AP** so a DUT (ESP32-C6) is ImprovBLE-provisioned onto
the rig itself — no dependence on a nearby WiFi network. Plus two supporting
changes: the `hitl` CLI discovers rigs by the `tag:splanc-hitl` tailnet tag, and
the Python e2e harness now shells out to the `hitl` CLI for everything (reserve /
flash / cp / run / forward) instead of reimplementing reservation in Python.

- Daemon serves the AP creds in `/status`; `hitl wifi` prints them; the e2e uses
  them automatically (no `--wifi-ssid` needed).
- e2e default WS scheme is now **wss (:443)** — that's the device's real TLS
  player socket; the plain `:81` isn't functional on the STA interface.

### Networking: Ethernet uplink + dedicated always-on AP (current, robust)

The rig's uplink is **Ethernet (`end0`)**, so the onboard WiFi radio (`wlan0`) is a
**dedicated, always-on 2.4 GHz AP** — NM profile `hitl-ap`, `autoconnect=true`,
`autoconnect-priority=999`, fixed **channel 6**, `ipv4.method=shared` (dnsmasq DHCP

- NAT on `10.42.0.0/24`, NAT'd out via Ethernet). No STA on `wlan0`, so none of the
  single-radio fragility below. This is the intended setup (`nix/hitl-app.nix`).

⚠️ **Live runtime state not captured in nix (clean this up):**

- The STA profile `seed-CoolerKids` was **deleted at runtime** (`nmcli con delete`)
  so it wouldn't fight the AP for `wlan0`. Baked STA profiles (`sbc-wifi-*` from
  `wifi.yaml`) still exist but aren't in range; the AP's priority 999 wins `wlan0`
  regardless. A future cleanup should make "wlan0 is AP-only" fully declarative
  (e.g. stop baking STA profiles on this rig).
- If Ethernet is unplugged, the rig has **no WiFi uplink** (by design) — it'd be
  unreachable until WiFi STA is re-added.

### The STA+AP-on-one-radio workaround (SUPERSEDED — history for context)

Before Ethernet, we ran **concurrent AP+STA on the single radio**. It works but is
fragile, and the workaround is worth knowing if anyone revisits a WiFi-uplink rig:

- Single radio ⇒ `#channels ≤ 1` ⇒ the AP is **co-channel with the STA**. The C6 is
  2.4-only, so the STA (hence the AP) had to be on 2.4 GHz.
- `wifi.band=bg` constrains the **initial** connect but **not roaming** — on a
  dual-band network (e.g. CoolerKids) wpa_supplicant roamed to 5 GHz and dragged
  the AP with it, so the C6 couldn't join. The AP's own ACS also prefers 5 GHz.
- The workaround that actually held 2.4: **lock the STA to a specific 2.4 GHz
  BSSID** (`nmcli con modify <sta> 802-11-wireless.bssid <ch-9-AP-MAC> band bg`),
  which pins the channel and forces the co-channel AP to 2.4. It worked but is
  location-specific (tied to one AP's MAC) — Ethernet removes the need entirely.
- The per-reservation AP machinery from that era is **retained but dormant**:
  `internal/ap` (on-demand `iw` vif creation on the STA's PHY + `nmcli` toggle),
  `queue.WithAP`, and the daemon's `--ap-conn/--ap-iface/--iw/--ip` flags. It's NOT
  wired in the current config (no `--ap-conn`); kept for the future multi-DUT design
  (per-reservation AP-per-DUT). The daemon serves creds via `--ap-ssid/--ap-psk`
  independent of that path.

### RESOLVED: container→DUT reject (was blocking the e2e WS check + agents poking the DUT)

The e2e's WS check tunnels from the agent's container to the DUT via `hitl forward`
(ssh -L; the far end dials the DUT **from the reservation container**). The
container could not reach the DUT at all — root-caused with an `nft monitor trace`:

- **NetworkManager's shared mode** (`ipv4.method=shared`) installs a private
  native-nft table `nm-shared-<iface>` whose `filter_forward` chain ends in
  `iifname "wlan0" reject` / `oifname "wlan0" reject`. That catch-all **rejects
  every NEW connection forwarded INTO the AP subnet** (shared mode expects clients
  to reach OUT, not to be reached). It's a separate native-nft table, so
  `iptables -S` never showed it — the SYN was RST'd before egress (0 packets on
  wlan0). Not the DERP relay, not netavark, not the DUT.
- **Fix (confirmed on hardware):** allow the rig's podman bridge → the AP iface,
  inserted **before** the reject inside NM's own chain:
  `nft insert rule ip nm-shared-wlan0 filter_forward iifname "podman0" oifname "wlan0" accept`
  → `container→DUT:443` then does a full TLS handshake (`TLSv1.2`).
- NM regenerates that table only when the **AP connection (re)activates** — NOT on
  container start/stop or DUT (dis)association (all tested; the rule survives them).
  So a **NetworkManager dispatcher script** (in `hitl-app.nix`) re-inserts the rule
  on the AP's `up`/`dhcp4-change`/`connectivity-change` events, idempotently.
- The DUT serves **wss :443** only (`:80`/`:81` are dead on the STA iface), so the
  e2e defaults to `--ws-scheme wss`.

Alternative if the dispatcher ever proves flaky: drop `ipv4.method=shared` and run
our own DHCP (`services.dnsmasq`, port=0) + `networking.nat` on wlan0 → no
`nm-shared` table, forwarding governed by the (permissive) NixOS FORWARD chain.

### KNOWN OPEN ITEM: the DUT doesn't reliably stay associated to the AP

Separate from the fix above: the ESP32-C6 intermittently **drops off the AP**
(`iw dev wlan0 station dump` → 0 stations; `rig→DUT` goes dead), and a bare
`--reset` sometimes lands it in its own soft-AP (`ledmapper`) instead of rejoining.
This — plus flaky BLE provisioning (wifi+BLE coexistence on the combo chip) — made
full-e2e verification painful and is likely why some WS runs failed even with the
forward fix in place. Worth chasing on the firmware/RF side (power-save? fixed
channel 6 interference?), and it matters for real use (agents need the DUT to stay
joined). The forward fix itself is verified at the reachability layer regardless.

### Rig access (for the next agent — this was a time sink)

- **tailscale SSH:** `ssh root@hitl-rig` works now that the tailnet ACL has an
  `ssh` grant for `autogroup:member → tag:splanc-hitl` with `users:["root",...]`
  and `action:"accept"` (NOT `"check"` — headless can't browser-auth).
- **deploy key over LAN:** `ssh -i pi/secrets/deploy_key root@hitl-rig.local` also
  works (mDNS → real sshd), but mDNS from a container is flaky; the tailnet name
  hits tailscale-SSH (needs the ACL). `hitl-rig` (tailnet) ≠ `hitl-rig.local` (LAN).
- **daemon on the rig:** `curl http://localhost:8087/status` (+ `/reservation/<id>/
release`) is the reliable way to inspect/free the rig when the tailnet CLI path
  is timing out.

### Gotchas

- **BLE provisioning is intermittently flaky** (~half the runs `TimeoutError`) —
  wifi+BLE coexist on the Pi combo chip; worse under concurrent AP+STA. Retry.
  Ethernet (radio does only AP now) may reduce this — re-check.
- A `hitl-flash --erase-fs` wipes the DUT's saved WiFi creds; after that only a
  fresh ImprovBLE provision (not a bare reset) rejoins it.
- The DUT brings up its wss `:443` server only after a real provision, not a bare
  reset-rejoin.

### Verify

- In-container: `bazel test //pi/hitl/internal/... //pi/hitl/tests:hitl_test`.
- On hardware (after `bazel run //pi/hitl:hitl.deploy_live -- hitl-rig`):
  `hitl wifi` prints the SSID/PSK; `nmcli` on the rig shows `hitl-ap:wlan0:activated`
  on channel 6; `bazel run //pi/hitl/harness:e2e` flashes → provisions the DUT onto
  `hitl-<hostname>` → checks time-sync/rename over wss.
