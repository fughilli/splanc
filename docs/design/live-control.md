# Live control: bounded latency for knobs, faders and MIDI

Status: implemented. Code: `web/src/net/liveSender.ts`, `web/src/net/liveControl.ts`,
`LedMapperClient.live`; firmware `ControlAck` (`firmware/player_app/ffi.rs`,
`main.cpp` `dispatch_plain`, `netstack_transport.cpp`), the live mailbox
(`lm_live_post` / `lm_live_drain`); HITL gate `//pi/hitl/harness:live_latency_netstack`;
on-LAN budget bench `//pi/hitl/harness:ctrl_budget_netstack`.

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
  device has acknowledged it, or until the **adaptive ack timeout** passes: 3x the
  median round trip of recently answered batches, 25–400 ms (400 until there are five
  samples). A lost ack — a device→client segment the device only resends on its
  >= 120 ms RTO, or an ack dropped on a full send window — then costs ~one LAN round
  trip, not a fixed 400 ms (light effect, LAN: p99 224 -> 40 ms). The backlog stays
  bounded: one batch per timeout at most, and never faster than the rate cap.
  `maxInFlight` (LiveControlOptions) allows more unacknowledged seq'd batches; it is
  1 by default because a second batch didn't reliably help on the bench, and on
  pre-mailbox firmware it queued moves behind the render mutex (p99 x1.6, seconds of
  backlog under load). Legacy reply pacing always keeps one.
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
- **The live mailbox (feature `live_mailbox`).** A seq'd, `commit: false`
  `set_uniforms` — a live move — is not handled under the player mutex: the network
  task stashes it (latest value per deck+slot, 16 keys, all-or-nothing; overflow falls
  back to the locked path) and acks at once; the render task applies what waits right
  before the next frame's `update()` — the same frame boundary the locked path reached,
  but the ack (the client's pacing signal) no longer waits behind a render frame. A
  locked `set_uniforms` applies the waiting moves first, so it still wins; an effect
  load clears the mailbox.
- **loopTask never parks on the render mutex.** The per-pass polls (perf push, fps
  notify, the 5 s status line) read lock-free or try-lock: a blocking take there held
  loopTask off the RX ring for the rest of every render frame (a message waited ~a
  whole frame before it was even reaped; 400 OSC datagrams/s overflowed the ring
  until the session died). It must not run its whole pass inside a frame either: with
  a wss client up the loop sits at render's priority, and a full pass on every tick
  (policy, OTA, BLE, status, timers) evicted the effect from the flash cache — fx_bench
  frame cycles +11..+22 %, a heavy gate frame 54 -> 65 ms. While render holds the mutex
  (`g_render_in_frame`) loop() only polls the RX ring (one descriptor scan,
  `netstack_rx_pending`) every 4 ms, runs the netstack when something arrived, and
  otherwise waits on the mutex until the frame ends; the rest of the pass runs between
  frames. That costs ~1 % of frame cycles (absfM 1.557 -> 1.576 M on rig-1, vs 1.90 M
  with a full pass per tick). The OSC / live-mailbox drain runs at the frame boundary
  just before the timed update span, and only calls into the mailbox when a move was
  posted. The `LM_CTRL_TRACE` stamps (main.cpp and the transport's RX/TLS/reply stamps,
  via `:netstack_transport_ctrltrace`) exist only in the measurement image.
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

## Measuring the budget

`//pi/hitl/harness:ctrl_budget_netstack` measures on the rig LAN, not through the
tailnet tunnel (whose 110–160 ms RTT hid everything below): it flashes an
`LM_CTRL_TRACE` image (`esp32c6_netstack_ctrltrace_flashbundle`) that stamps every
control message (RX-ring reap, TLS decode, dispatch, mutex, handled, reply) and every
frame (start, shade end, transmit, wire done) in esp_timer µs, runs a stdlib probe
inside the reservation (4 knobs x 100 Hz over wss or OSC, optional +N pps background
UDP), and attributes each counter value's latency to its stages on a min-delay clock
fit. `--ab-bundle` A/Bs firmwares on one DUT.

Input -> applied (the value is in a frame) / -> photon (that frame is on the LEDs),
p50 / p99 ms, 150 LEDs, rig-2 LAN; heavy = the gate's shader at its 25 fps floor,
light = trivial shade pinned at 60 fps:

| config | frame | before (#354) applied | now applied | now photon | target (1 frame + 10 / 2 frames + 20) |
|---|---|---|---|---|---|
| heavy wss | 54 -> 65 | 158 / 330 | 58 / 103 | 123 / 170 | 75 / 150 |
| heavy wss +400 pps | 67 -> 89 | 328 / 907 | 69 / 126 | 157 / 215 | 99 / 198 |
| heavy OSC | 56 -> 69 | session dies | 43 / 97 | 106 / 167 | 79 / 158 |
| light wss | 17 | 23 / 224 | 19 / 40 | 27 / 49 | 27 / 54 |
| light wss +400 pps | 17 | 26 / 246 | 19 / 39 | 29 / 49 | 27 / 54 |
| light OSC | 17 | 12 / 31 | 10 / 18 | 19 / 28 | 27 / 54 |

Where the heavy-effect time went before: ~55 ms client pacing, ~51 ms in the RX ring
(loopTask parked on the mutex), ~3 ms decode, ~50 ms on the mutex at dispatch (the
one-in-flight sender phase-locks to the frame), ~4 ms to the frame start, 50 ms render,
5 ms wire. The Wi-Fi one-way floor is ~1 ms. What remains is the physical floor: a move
waits for the next frame boundary (U[0, frame]) and then a whole render; applying
mid-frame would only shorten the wait for the next boundary, at the cost of tearing.

## Verification

- `web/tests/liveControl.test.ts`: pacing, merging, commit-on-idle, legacy pacing,
  the client wire round trip, and a model of a slow device under a 4 × 100 Hz knob
  stream (per-event sends fall tens of seconds behind; the channel's p99 lag stays
  under 100 ms with no growth).
- `pi/hitl/tests/test_live_latency.py`: the HITL gate's pure core (a Python port of
  the channel, the lag arithmetic, the verdict).
- `//pi/hitl/harness:live_latency_netstack`: on hardware, a heavy effect + 4 knobs ×
  100 Hz for 4 minutes, then 30 s of OSC; the stream runs INSIDE the reservation, on
  the rig AP (`ctrl_budget_probe.py --gate`, the app's live-channel policy), and a
  `get_effect_uniforms` echo of the counter knob every 250 ms measures how long the
  oldest unapplied value had waited. Gates p50 <= 1 frame + 50 ms, p99 <= 3 frames +
  120 ms (frame = the effect's measured period; measured 71–75 / 150 ms at a 60 ms
  frame on rig-1/rig-2, ~151 / 320 ms on #354 firmware), no growth between the first
  and last minute, no probe timeout, no dropped session; too few samples with nothing
  over budget is SKIP. `--path tunnel` keeps the original harness-host path and its
  RTT-relative budgets; `--sender naive` replays the pre-fix app.
- `//pi/hitl/harness:ctrl_budget_netstack` (manual): the per-stage budget above.
- `pi/hitl/tests/test_ctrl_budget.py`: the bench's attribution on a synthetic trace.
