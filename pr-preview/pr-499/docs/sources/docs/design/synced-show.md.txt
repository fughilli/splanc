# Synced show

## Scheduled changes (apply_at)

A control change sent to N players applies on arrival, so a room changes spread
over each player's Wi-Fi latency (tens of ms, more under load). With the shared
time base (`set_time_base`, `agent/src/hub.ts` `alignTime`) every player already
agrees on effect time; `apply_at_ms` uses the same clock for the change itself.

**Protocol.** `SetUniforms`, `SetEffect`, `SetCrossfade` and `SetBrightness` carry
`optional uint32 apply_at_ms`: ms on the time base (effect time, like
`SetTexture.present_at_ms`). Firmware advertises `apply_at`. Unset, no time base,
already due, or more than 10 s ahead (a stale epoch) means apply on arrival,
today's behaviour. The reply goes out on arrival (it shows the state before the
change); persistence flags are recorded on arrival too.

**Firmware.** `lm_player_handle` holds a scheduled frame, as raw bytes, in
`SCHED` (`firmware/player/src/apply_queue.rs`: 8 frames sharing 512 B on the C6,
16 / 2 KB on the P4). The render task calls `lm_sched_apply(millis())` at the top
of every frame, under the player mutex, before anything reads the effect, the
crossfade or the brightness. Every frame due by then is applied in due order (ties
keep arrival order), through the same apply code as the immediate path. Nothing is
dropped, unlike video frames: a late change applies on arrival. When the queue is
full, its earliest frame is applied early to make room. A device-clock step moves
the queue with the time base (`lm_clock_observe`). A scheduled live move
(`seq` + `commit:false`) skips the unlocked live mailbox and is queued like the
rest; it is still acked on arrival.

**Bridge.** `set_uniforms`, `ramp_uniforms`, `set_effect`, `crossfade_to` and
`set_brightness` take `lead_ms`. By default the lead is 150 ms when several players
are targeted and all of them have `apply_at`. Otherwise changes apply on arrival,
and the result says which players caused that. An explicit lead schedules every
player that can take it and names the others. `0` means on arrival. The hub picks
one instant `at` on its own clock and gives each player
`apply_at = at - epoch`, where `epoch` is the room epoch `alignTime` gave that
player. The player's clock offset is already folded into its epoch, so the
instant is the same everywhere. If a capable target has no epoch yet, the hub
aligns first, re-using the epoch the others share so running effects don't jump.
Ramps and crossfades run on one shared timeline: step *i* is scheduled for
`at + i·step`, sent a lead ahead, and paced on the player's ack. A player that
falls behind skips steps instead of drifting late. The final committed set or
landing position is scheduled too. Residual skew is the time-base skew (half the
clock-sync round trips) plus at most one render frame.
