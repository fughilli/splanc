# Matter interop check with the CHIP SDK controller

`tests/matter.test.ts` (CI) commissions the bridge with matter.js's own controller. This check
uses an independent implementation instead: the CHIP SDK (connectedhomeip) Python controller
that Home Assistant's Matter server is built on. It runs by hand, on Linux (x86_64 or aarch64).

It covers: commissioning with the bridge's own manual code, the device attestation chain (test
PAA), reading the bridged lamp's label, and On / Off / MoveToLevel reaching the lamp (a fake TLS
player behind the real hub and `HubLamps`).

## Setup (once)

```sh
python3 -m venv /tmp/chipvenv
/tmp/chipvenv/bin/pip install home-assistant-chip-core==2025.7.0 home-assistant-chip-clusters==2025.7.0
# The wheel needs libnl (Debian/Ubuntu: apt install libnl-3-200 libnl-route-3-200; or extract
# the .debs and point LD_LIBRARY_PATH at them) and a writable /data (its KVS files live there).
mkdir -p /tmp/paa && cd /tmp/paa
for f in Chip-Test-PAA-FFF1-Cert.der Chip-Test-PAA-NoVID-Cert.der; do
  curl -fsSLO https://raw.githubusercontent.com/project-chip/connectedhomeip/master/credentials/development/paa-root-certs/$f
done
```

Without root, `/data` can't be created: patch the paths in a copy of the wheel's
`chip/_ChipDeviceCtrl.so` (same length: `/data/chip_` -> `/tmp//chip_`).

## Run

```sh
cd agent
AGENT_TEST_ENTRY=matter_interop_host.ts npx vite build --mode test
mkdir -p /tmp/interop
INTEROP_DIR=/tmp/interop node dist-test/matter_interop_host.ts/matter_interop_host.mjs &
# wait for /tmp/interop/code.json, then:
/tmp/chipvenv/bin/python tools/matter_interop/chip_interop.py /tmp/interop /tmp/paa
touch /tmp/interop/stop
```

Expected (2026-11-20, matter.js 0.18.0, chip-core 2025.7.0):

```text
COMMISSIONED with the bridge's manual code
aggregator parts [2]
lamp label Coil
onOff before True
onOff after Off False
onOff after On True
lamp saw: {"brightness":["0.25196850393700787","0","0.25196850393700787"], ...}
```

The fake lamp has no "power" feature, so on/off arrives as brightness 0 / the last level
(lamps.ts). The level command (64 -> 0.252) came before Off.
