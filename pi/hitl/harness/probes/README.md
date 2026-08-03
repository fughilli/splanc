# HITL probes

Standalone diagnostics for poking a reserved DUT from the rig — not part of the
e2e build, just dev tools for when connectivity/ws behavior needs investigating.
Run them from `pi/hitl/harness/` (they import the client libs from the parent).

Common env: `HITL_SERVERS=http://<rig>:8087` (the rig pool), and where noted
`HITL_BUNDLE=/path/to/esp32c6_flashbundle.tar`
(`bazel build //firmware/player_app:esp32c6_flashbundle` →
`bazel-bin/firmware/player_app/esp32c6_flashbundle.tar`).

## `reach.py`
Reserve → flash → read the DUT's LAN IP off the boot serial → from the rig,
check TCP `:80/:81/:443` and run a real WebSocket upgrade against `:81`. Answers
"can the rig reach the player and is the ws endpoint healthy?" without BLE.

```
HITL_SERVERS=http://100.99.64.43:8087 \
HITL_BUNDLE=$PWD/../../../bazel-bin/firmware/player_app/esp32c6_flashbundle.tar \
python3 probes/reach.py
```

## `ws_handshake.py`
Raw RFC6455 upgrade probe, meant to run **on the rig** against the DUT
(`reach.py` scp's + invokes it). Reads the full response and validates
`Sec-WebSocket-Accept`, distinguishing "TCP open but no handshake" (the classic
timed-out-during-opening-handshake symptom) from a correct `101`.

```
python3 ws_handshake.py <dut-ip> 81
```
