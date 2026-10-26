# Live control: bounded latency for knobs, faders and MIDI

Status: implemented. Code: `web/src/net/liveSender.ts`, `web/src/net/liveControl.ts`,
`LedMapperClient.live`; firmware `ControlAck` (`firmware/player_app/ffi.rs`,
`main.cpp` `dispatch_plain`, `netstack_transport.cpp`); HITL gate
`//pi/hitl/harness:live_latency_netstack`.

## The problem

A performer turning MIDI knobs on a netstack C6 saw input lag that grew the longer
they played. The app sent one `set_uniforms` per CC event (a Twister knob pushes
~100 Hz; four knobs make 400 messages/s) with no pacing. The device drains far fewer:

- the render task runs at a higher priority than the network loop, and the fps
  autoscaler (`firmware/fps`) leaves the network as little as 5 % of the CPU under a
  heavy effect;
- every `set_uniforms` was answered with a `playback_state` (`set_crossfade` with a
  full `welcome`): one more TLS record, TCP segment and Wi-Fi TX each;
- a full 2 KB TCP send window made `tls_write_all` spin for up to 3 s, and no frame
  behind the stalled reply was read meanwhile;
- with no `commit` field every set was persisted, so a littlefs write landed on the
  network task 1.5 s after any pause.

Messages the device couldn't take queued in the phone's (or the tunnel's) socket
buffers, where they stayed: lag grew without bound, and the device worked through
seconds of stale knob positions after the performer stopped.

## The design

**One live-control channel per connection** (`client.live`), used by every live
control: the effect editor's sliders, acid mode, Show Mode's crossfader and keypoint
strip, the MIDI router, colour-correction test controls, the agent's live mux and its
ramps.

- **Latest value wins.** Moves are merged per (deck, slot); the crossfade and a
  keypoint blend per deck.
- **One batch in flight.** A batch is at most one `set_uniforms` per deck, one
  `set_crossfade` and one `blend_keypoints` per deck. Nothing else goes out until the
  device has acknowledged it (or 400 ms passed: a dropped ack, a silent firmware).
  The backlog is bounded at one batch, whatever the input rate.
- **Never faster than the device renders.** Consecutive batches are at least one
  render period apart (the device's `currentFps`, 8–100 ms).
- **Transport gate.** A batch waits while the socket still has more than 1 KB queued
  (`bufferedAmount`; the iOS native socket tracks its unfinished sends), so control
  never piles onto an upload or texture stream.
- **Commit once, on idle.** On firmware with `uniform_commit`, moves go out with
  `commit: false` (RAM only). 600 ms after a deck's last move (or on
  `live.commit()`), one `commit: true` set with every slot touched since the deck's
  effect changed follows, so the persisted frame restores the whole state.
- **Effect changes.** `submitEffect` / `setEffect` drop pending moves for that deck:
  slot numbers mean nothing to the new effect.

The pacing primitive (`LatestWinsSender`) is generic (key → value, a send that
returns an ack promise) so other streams can reuse it.

### Protocol: `seq` and `ControlAck` (feature `control_ack`)

`SetUniforms.seq` (4) and `SetCrossfade.seq` (3): non-zero asks for a
`ControlAck { seq }` (ServerMessage 41, ~6 bytes) instead of the legacy reply, sent
once the update is applied. `seq` 0 (unset) keeps today's replies, so older apps are
unaffected. On firmware without `control_ack` the channel paces on the legacy reply
(`playback_state` for `set_uniforms` / `blend_keypoints`, `welcome` for
`set_crossfade`). `blend_keypoints` has no seq and is paced on its `playback_state`.

### Firmware

- `lm_player_handle` notes whether a frame was a live control and its seq; after the
  reply's persistence is decided (`persist_if_upload` still sees the legacy reply),
  `dispatch_plain` swaps the reply for the ControlAck (`lm_take_control_ack`).
- **No RX stall on a full window.** A best-effort live-control reply (a ControlAck,
  or a legacy `set_uniforms`' `playback_state`, which no client awaits) is dropped
  when the TCP send window can't take it, like an unsolicited PerfReport, instead of
  blocking every frame behind it in `tls_write_all`.
- **Persist off the gesture.** The coalesced effect-selection save waits until the
  live controls (committed or not) have also been quiet for 1.5 s, so a littlefs
  write never lands mid-turn.

### Agent and bridge

`DeviceSession.sendLiveUniforms` and `liveCrossfade` push into the session client's
live channel and resolve once the player has acknowledged. The bridge mux
(`agent/src/bridge/live.ts`) already merges per control and awaits each flush, so a
performer behind the relay keeps the same bound; the web bridge client
(`bridgeLive.ts`) also holds its coalesced patch while the relay socket has more
than 8 KB queued. `ramp_uniforms` steps go through the same channel.

## Verification

- `web/tests/liveControl.test.ts`: pacing, merging, commit-on-idle, legacy pacing,
  the client wire round trip, and a model of a slow device under a 4 × 100 Hz knob
  stream (per-event sends fall tens of seconds behind; the channel's p99 lag stays
  under 100 ms with no growth).
- `pi/hitl/tests/test_live_latency.py`: the HITL gate's pure core (a Python port of
  the channel, the lag arithmetic, the verdict).
- `//pi/hitl/harness:live_latency_netstack`: on hardware, a heavy effect + 4 knobs ×
  100 Hz for 4 minutes; a `get_effect_uniforms` echo of a counter knob measures
  input-to-applied lag. Gates p50 ≤ base RTT + 150 ms, p99 ≤ 2 × base RTT + 600 ms,
  and the last minute's p50 within max(60 ms, 50 %) of the first minute's.
  `--sender naive` replays the pre-fix app for the A/B.
