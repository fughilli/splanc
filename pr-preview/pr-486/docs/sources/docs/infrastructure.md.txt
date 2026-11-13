# Infrastructure topology

This describes the _shape_ of the hardware/service fleet behind splanc's CI and
hardware-in-the-loop testing, and how the pieces relate. It deliberately omits host
names, network identities/addresses, access-control details, and per-host
configuration — those are operational, security-sensitive details that live in the
private deployment config, not here.

## Hosts, by role

- **HITL rigs** — several small single-board computers, each running a _reservation
  daemon_ that exposes its attached ESP32 DUTs as a reservable pool, plus a local
  WiFi access point the DUTs are provisioned onto over BLE. Rigs add optional
  capabilities as deploy-time flags: a shared logic analyzer, a USB radio used as
  the access point, or serialized flashing for a shared USB bus. Rig class varies
  (some more capable than others), and at least one rig is dedicated to bringing up
  a new DUT chip and is kept out of the gating test lane.
- **RF / phone bench** — a larger x86_64 host driving software-defined radios and a
  real Android device (phone-in-the-loop), alongside its own DUTs.
- **iOS bench** — a macOS host: the macOS-only counterpart to the phone bench (a
  reservation daemon with a macOS execution backend, a real iOS device, and its
  DUTs). iOS tooling requires macOS, so this role is hardware-locked to a Mac.
- **Binary cache** — an always-on host serving a self-hosted Nix binary cache that
  every other host pulls expensive build artifacts from during deploys, so closures
  are neither rebuilt per host nor shipped over each host's uplink. Cache contents
  are signed and the hosts trust the cache's public key.
- **Build host** — builds cross-architecture deploy closures.

## Fabric

All hosts join a single private mesh network and address each other by mesh identity
rather than public DNS/IP. Reachability — not physical location — is what matters:
CI, developers, and the hosts themselves all reach the fleet the same way.

## How work flows

- **Reservation model.** Every rig and bench runs the same reservation daemon on a
  fixed port. A client (a CI job or a developer) reserves a _free_ device from the
  pool, flashes and provisions it, runs its test, then releases it. A FIFO queue with
  lease heartbeats serializes contention onto the physical bench without serializing
  the CI layer, so many CI runs proceed in parallel and simply wait their turn for a
  device.
- **Deploys.** Hosts are configured declaratively with Nix (NixOS / nix-darwin). A
  deploy builds the host's closure — pulling shared paths from the binary cache — and
  pushes it to the host over the mesh. Per-host capabilities are deploy-time flags,
  not separate images.
- **Observability.** CI run logs are parsed by an ingest job into a compact data
  artifact (published as a release asset); a hosted Grafana reads that artifact
  through a datasource and renders the performance-drift and rig-health dashboards.
- **Periodic monitoring.** An always-on host triggers the hardware test suite on a
  fixed cadence (via a CI workflow dispatch), because the CI provider's own scheduler
  drops and heavily delays scheduled runs.

## Dependency sketch

```text
         ┌──────────────── private mesh ────────────────┐
  CI  ──▶│   reserve + run  ▶  HITL rigs / RF / iOS      │
  dev ──▶│                     benches (device pools)    │
         └───────┬──────────────────────────┬───────────┘
                 │ deploy: push closure      │ pull signed paths
                 ▼                           ▼
             each host  ◀───────────  binary cache
                                              ▲
                                              │ (deploys build against it)
  CI logs ─▶ ingest ─▶ release artifact ─▶ Grafana dashboards
  always-on host ─▶ (periodic) workflow dispatch ─▶ CI
```

## Deliberately out of scope here

Host names, mesh identities / tags / access-control policy, addresses, secrets, and
per-host configuration are intentionally omitted — they are operational,
security-sensitive details that live in the private deployment config, not in this
repository.
