# Design: effect state across the mesh, and agents that travel between fixtures

Status: proposal (2026-11-23). Extends [effects-runtime.md](effects-runtime.md) and mesh M6
([mesh-m6.md](mesh-m6.md): effect sharing, scenes and catch-up).

## Why

Found on the owner's bench (CalvinLamp and SilviasLamp, one mesh):

- **A rejoin loses accumulated state.** A catch-up restores the effect, deck A's and deck B's
  uniforms, brightness and the crossfade, and the show clock (`time`) is shared. But `state`
  lives only in each fixture's VM. An effect that integrates its phase,
  `state float phase; phase = phase + speed * dt;`, restarts at 0 on the rebooted fixture,
  so it renders out of phase with the others for as long as the effect runs.
- **Not all state should be restored.** An effect whose agents travel between fixtures (a
  firefly that flies from one lamp to the next) keeps those agents in `state`. Copying the
  gateway's agents into a rebooted fixture would duplicate them.
- **Effects can't talk to each other.** Today a fixture knows nothing of the others: no
  positions, no neighbours, no way to hand something over. Agents that travel need both.

## Part 1: what a rejoin restores

### The language

A qualifier on the `state` declaration says whether a catch-up restores it:

```glsl
shared state float phase;          // restored on a rejoin: copied from the gateway
state Agent agents[8];             // this fixture's own: a rejoin starts it empty
```

- `shared state` is copied from the gateway's VM into a fixture that rejoins (a reboot, or a
  dropout long enough to need a catch-up). Use it for anything every fixture should agree on:
  integrated phases, a global wavefront position, a beat counter, a palette index that steps.
- Plain `state` stays per fixture, as today, and starts from its zero values on a rejoin. Use
  it for agents, spawn lists, per-fixture feedback buffers, and anything that only makes sense
  for this fixture's LEDs.
- The qualifier covers a whole declaration (an array or a struct is restored or not as a
  unit). `buffer`s and `texture`s are never restored: they are per-LED, and per-LED data
  is meaningless on another fixture's map.

**Decision needed: the default.** The proposal keeps plain `state` local, so every existing
effect behaves exactly as now and nothing is ever duplicated by accident. The cost is that
phase-style effects need `shared` to survive a rejoin. The other choice, restoring by default
with a `local state` opt-out, fixes today's phase effects with no edits. But it duplicates
agents in any effect whose author didn't know to opt out. Recommendation: local by default.
Add a compiler lint ("`phase` is integrated from `dt`: mark it `shared` so a rejoin keeps
it") so the common case is caught, and teach the AI-generation prompt the rule.

### What goes over the air

- **Compiler** (`fx_compiler/src/lib.rs`, `state_decl`): record each state declaration's
  slot range and qualifier. The `.fxb` gains a state manifest section: `[(slot, width,
  shared)]`, with names for the debugger. This means a version bump. A `FXB1` file without
  the section has no shared state, which is today's behaviour.
- **VM** (`firmware/fx_vm`): `snapshot_shared(out)` and `restore_shared(in)`, both
  over the manifest's shared slots (≤ 128 slots, so ≤ 512 B), plus a layout hash so a
  snapshot only ever restores into the same build of the effect.
- **Catch-up** (`mesh_blob.rs` `catch_up`, `ffi.rs` `lm_fx_scene_frames`): the state blob gains
  one more frame per deck, `set_fx_state{deck, layout_hash, mesh_time_ms, slots}`. The
  gateway takes it under the player mutex at a frame boundary, so it is one consistent frame.
- **Applying it**: the member restores the slots at its first frame after the effect load,
  then runs that frame's `update()` with `dt` = its own frame `dt` + (mesh time now −
  `mesh_time_ms`). That is the time spent in transit and loading. An integrator
  (`phase += speed * dt`) then lands exactly where the gateway's is. Nonlinear updates take
  one larger step, which is the same as one slow frame.
- **Drift**: fixtures integrating the same `shared` value from the same start stay together,
  because each frame's `dt` comes from the shared clock. Float rounding drifts slowly.
  Option, not in the first cut: a gateway re-broadcasts the shared snapshot every N
  seconds, and members slew toward it.

This alone fixes the bench bug, once the effect marks its phase `shared`.

## Part 2: agents that travel between fixtures

### What an effect can see

Built-ins, read-only, refreshed by the runtime between frames:

| Built-in | Meaning |
| --- | --- |
| `fixture.id` | this fixture's mesh node id (int) |
| `fixture.pos` | its room-frame position (`FixturePose.translation`, metres; 0 when unposed) |
| `peer_count()` | members running **the same effect** (same hash) right now, ≤ 16 |
| `peer_id(i)`, `peer_pos(i)` | the i-th peer's id and room position |
| `peer_hops(i)`, `peer_rssi(i)` | how far it is over the mesh |
| `nearest_peer(vec3 p)` | the peer whose position is nearest `p` (-1: none) |
| `peer_toward(vec3 dir)` | the nearest peer within 60° of `dir` from `fixture.pos` (-1: none) |

Positions come from the room pose each fixture already persists (`set_fixture_pose`, read
by effects today as `led.room`). Members add their pose and their effect's hash to the
status they broadcast once a second (`lm_mesh_status_fill`, about 20 B more). So "peers"
means fixtures in the same mesh running the same effect. An unposed mesh still has ids and
hop counts, just no geometry.

### Sending and receiving

```glsl
struct Firefly { vec3 pos; vec3 vel; float hue; };
state Firefly flies[4];
state int n;

void update() {
    for (int i = 0; i < n; i = i + 1) {
        // ... fly; when one leaves our box, hand it to whoever is that way
        if (outside(flies[i].pos)) {
            int to = peer_toward(flies[i].vel);
            if (to >= 0 && send(to, vec4(flies[i].pos, flies[i].hue), vec4(flies[i].vel, 0.0))) {
                remove(i);             // it is theirs once send() accepted it
            } else {
                bounce(i);             // nobody that way: turn around
            }
        }
    }
}

// Called before update(), once per message that arrived since the last frame.
void receive(Msg m) {
    if (m.bounced) { adopt(m.a, m.b); return; }  // the hand-off failed: it comes back to us
    adopt(m.a, m.b);
}
```

- `bool send(int peer, vec4 a, vec4 b)`: queue a message of two `vec4`s (32 B) for `peer`.
  It returns false when the queue is full or the peer is unknown, and the effect keeps its
  agent. `broadcast(vec4 a, vec4 b)` goes to every peer, for events rather than agents.
- `void receive(Msg m)` is a new optional entry point next to `update` and `shade`. It runs
  on the render task at the start of the frame, before `update()`. `Msg` has `from` (id),
  `a`, `b`, `age` (seconds in flight, on the mesh clock) and `bounced`.

### Delivery: no duplicated agents, no lost ones

A hand-off must not duplicate an agent and should not lose one:

- The message goes as an ACKed mesh unicast, with the MAC retries the backhaul already does.
  The receiver dedupes by (sender, sequence number), so a retry never delivers twice.
- If the mesh gives up (no ACK within 500 ms, or the peer left), the message comes back to
  the sender's `receive()` with `bounced = true`, and the agent re-appears where it left.
- The one ambiguous case: the receiver got it but its ACK was lost every time. Then the
  sender bounces and the receiver also adopted it, which is a duplicate. To rule that out,
  the sender waits for a second-phase "adopted" confirmation before it forgets the message.
  That costs one more round trip (about 40 ms on the bench), and the agent is in flight,
  shown nowhere, meanwhile. Recommendation: build the two-phase version. Agents spend
  ~40 ms invisible between lamps, which reads as "flying between them".
- Plain `state` is local (Part 1), so a rejoin never resurrects agents either. A fixture
  that reboots loses the agents it held. Optional later: a peer whose hand-offs to it bounce
  keeps the agent.

### Limits and safety

- Budget: 8 queued messages per fixture and 20 per second. Beyond that `send` returns false.
  At 32 B each this is negligible next to a live-uniform stream.
- Only fixtures running the same effect hash receive one; anything else is dropped (and
  bounced). So two different effects never misread each other's vectors.
- Effect messages ride a new mesh port, authenticated with the mesh key like other member
  traffic, and they reach the VM only. They can't set uniforms, load effects or touch
  control. An insider can forge them (desk Q25's threat model), but the worst case is
  visual.
- The P4 lamp (once it is a mesh member): the C6 front end forwards effect messages to the
  P4's VM over the link, as it will for relayed control.

### Authoring

Agent effects can't be tested on one fixture. The web preview gets a "mesh" mode: N fixture
VMs side by side with poses from the room view, and a simulated mesh with configurable
latency and loss, using the same `peer_*`, `send` and `receive` semantics. The AI-generation
prompt documents the API and the `shared state` rule.

## Plan

1. **`shared state`** (Part 1): compiler, `.fxb` section, VM snapshot and restore, the
   catch-up frame, transit `dt`, the lint. Small, and it fixes the bench bug. HITL: the M6
   catch-up gate gains "an integrated `shared` phase matches after a reboot".
2. **Peers**: pose and effect hash in the status broadcast, and the `fixture.*` / `peer_*`
   built-ins.
3. **Messages**: `send`, `broadcast`, `receive`, two-phase hand-off, bounce, budget. Needs a
   two-fixture HITL gate: N agents in, N agents out after 1000 hand-offs.
4. **Preview mesh mode** and the AI prompt.

## Decisions (owner desk, 2026-11-23)

- **Plain `state` stays local** (Part 1); `shared state` opts in. Built in #641.
- **D-509: two-phase hand-off** (Part 2). HITL gate: N agents in = N agents out after 1000
  hand-offs.
- **D-510: every mesh member is a peer**, not only fixtures running the same effect. So
  `peer_*` lists all members, and messages reach fixtures running other effects: each
  effect must check what it receives (for example a tag in `a.w`, or the sender's effect
  hash in `Msg`). The "same effect only" filter in *Limits and safety* above is replaced by
  this; delivery to a fixture whose effect has no `receive()` is dropped and bounced.
- **D-506 / D-507:** a state's initial value is constants only, and `init()` reads the same
  as `update()` (#636). A catch-up restore must win over `init()`: `init()` runs at load,
  before the catch-up's `set_fx_state` is handled, never after it.
