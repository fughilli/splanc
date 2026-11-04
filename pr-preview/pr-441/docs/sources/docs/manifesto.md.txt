# The Splanc manifesto

Splanc is a small system built on a few firm opinions. This page explains the
engineering decisions that surprise people, and what each one costs. If you
want to know _why_ the code looks the way it does, start here; for _how_ it
fits together, see the Architecture page of the docs site and
[`DEVELOPERS.md`](../DEVELOPERS.md).

The short version:

1. **The fixture knows its own shape.** Every LED has a measured 3D position,
   and effects are written against that geometry, not against a strip index.
2. **The controller does not fall over.** One cheap microcontroller per fixture
   runs the show itself. Memory is a budget we prove, not a pool we hope for.
3. **Anything can drive it.** A browser, a phone, a console over OSC, or an AI
   agent all use the same narrow, named, versioned interface.

Everything below follows from those three.

## Why a microcontroller, and not Art-Net nodes and show-control software?

The established way to light a sculpture is a pixel-mapping app (MadMapper,
Resolume, TouchDesigner, a lighting console) on a computer. It renders every
frame and streams the pixels as Art-Net or sACN to Ethernet nodes, which clock
them out to the strips. That stack is mature, it interoperates with every
console, and for a show with a technician and a laptop it is the right
answer.

Splanc is for the other case: an installation that has to run by itself, in a
living room, a shop window or a tree, for months, with nobody watching it.
There, the classic stack has three problems:

- **A computer has to stay up.** If the show PC sleeps, updates or loses
  Wi-Fi, the lights go dark. A Splanc fixture carries its effect in flash and
  resumes it at power-up with nothing else on the network
  (`firmware/player_app` replays the stored map and effect at boot).
- **Streaming pixels does not scale over Wi-Fi.** Art-Net is one frame of
  raw RGB per universe, many times a second, which is fine on wired Ethernet
  but fragile on a home access point. Splanc sends a program once (a few
  hundred bytes of `.fxb` bytecode) and then only the knobs that change.
- **The software does not know where the LEDs are.** Pixel mappers work on a
  2D canvas that someone lays out by hand. Splanc measures the 3D position of
  every LED with a phone (see below), so `led.pos` in an effect is metres in
  the real room.

So each fixture gets its own ESP32-C6, an inexpensive RISC-V microcontroller
with Wi-Fi 6 and BLE. It renders the effect locally, per LED, every frame, with
the same VM the browser preview runs (`firmware/fx_vm`).

**What it costs.** We give up the console ecosystem's native protocol, so
there is no Art-Net or sACN input. Show-control integration goes through
uniforms instead: OSC input on the device (`firmware/osc`), the TouchDesigner
plugin (`tools/touchdesigner`) and MIDI in the web app. We also accept a much
smaller machine: 512 KiB of SRAM, no FPU and a 160 MHz core. That last point
drives most of the decisions that follow. For fixtures beyond what one C6 can
drive, the Raspberry Pi and FPGA path (`pi/`, `fpga/`) is the bigger player.

## Why rewrite the vendor wireless stack?

Because the vendor stack was the thing that kept falling over.

The ESP-IDF networking path is general purpose: lwIP for TCP/IP, a malloc per
packet buffer, mbedTLS allocating its record buffers per session, an event
loop and a handful of tasks, all on one shared first-fit heap. On a 512 KiB
part also running BLE provisioning and an LED renderer, that heap fragments.
The failure we chased for months (FUG-71) was a TLS handshake that needs a
contiguous record buffer the fragmented heap could no longer supply.
`mbedtls_ssl_setup` returned `-0x7F00`, and the phone lost its connection
mid-capture.

The heapless netstack (`firmware/netstack`,
`firmware/player_app/netstack_transport.cpp`) keeps the vendor's PHY and
lower-MAC blobs, the part that is genuinely radio-specific, and owns
everything above them. That means our own RX ring, the STA association and
the WPA2 4-way handshake, CCMP on the AES accelerator, DHCP, ARP, TCP, the TLS
bio and the WebSocket layer. Its design rules ([`DESIGN.md`](../firmware/netstack/DESIGN.md)):
zero allocation after init, capacity-typed buffers, bounded parsers, fixed
pools with back-pressure instead of growth. The TX path builds each frame once,
in place, with headroom for every layer's header (#267). The BLE side is the
same idea: a heapless host over the vendor controller (`firmware/blehost`),
replacing Bluedroid's ~43 KiB permanent draw.

The result is that the network's memory is a compile-time constant you can
read with `size`. What's left of the vendor heap gets audited down to the
allocations nobody can avoid (see the [heap census](design/heap-census.md)).

**What it costs.** Maintenance, mostly. We reverse-engineered parts of the
vendor's MAC interface (the comments in `netstack_transport.cpp` say which),
we track their binary blobs across SDK upgrades, and we own interoperability
bugs a vendor stack would have absorbed for us. For example, group-key
handling that worked on our test rigs' access points and failed on commercial
mesh APs. We decided that owning a few thousand lines of bounded,
host-tested Rust is cheaper than a field failure we cannot reason about.

## Why no heap?

A heap's worst case depends on its _history_: which sizes were allocated and
freed, in what order. A system that must run for months cannot be tested into
confidence about a property that depends on history. So the player's rule is
that the shared heap allocates nothing after boot that we have not accounted
for, and mutually exclusive features share memory through typed regions
instead (`firmware/region`):

- **`Pool<T, N>`**: fixed slots, O(1), no fragmentation; full means "refused",
  never "corrupted".
- **`Slab`**: a few size classes, for C callers that insist on `malloc`.
- **`ModeRegion<S>`**: one storage holding a union of variants. Switching
  variants while anything borrowed from the current one is alive is a
  _borrow-check error_.

The work this unlocked (#262 to #273) took the measured worst-case minimum
free heap from **1.6 KiB to about 87 KiB**, while also reserving a dedicated
24 KiB region for TLS so a handshake can no longer fail on a fragmented heap.
The rest of the budget came from many small cuts rather than one big one:

- zero-copy protocol envelopes and in-place request dispatch;
- loopTask's stack sized from a proof instead of a guess (48 → 14 KiB);
- freeing the vendor Wi-Fi scan residue;
- moving 17 KiB of dead vendor code out of IRAM (`.iram0.text` 114,910 →
  97,512 B);
- unbuffered littlefs files.

Headroom is there to be spent deliberately. Later features each took a measured,
reviewed slice of it: the room-frame cache (3 KiB), a larger topology arena
(4 KiB), and a second effect deck with on-device keypoints (6.5 KB, plus 2.2 KB
of hot shade code pinned back into IRAM). With both decks running and a wss
session open, the keypoints HITL run still measured a 72.7 KB minimum free heap.
Each of those changes re-pinned the memory-mode model in the same PR.

The detail is in [ram-budget.md](design/ram-budget.md).

**What it costs.** Static sizing means choosing limits up front: the LED count,
the effect size, the number of TLS slots. A feature that wants "just a little
dynamic memory" needs a design conversation. That is a feature.

## Why bother with model checking for an LED controller?

Because the bug was a _state_, not a big buffer.

When we finally caught the heap at its minimum (a JTAG core dump at the
low-water mark, every block attributed), no single feature was too big. The
low point was a _combination_: BLE provisioning still resident while the first
TLS handshake allocated. Testing finds the combinations you think to test.
Proving the system safe means enumerating all of them.

So the device's memory modes are a small pure model (`firmware/sysmode`):

- Wi-Fi, BLE, wss, the current activity and the map are its axes;
- `step(state, event)` is a total transition function;
- every component has a RAM cost with a cited source.

A breadth-first reachability test visits every reachable state (57 today) and
asserts invariants, recoverability and that **no reachable state exceeds the
memory budget** (worst live set 151,213 B, pinned so any change is a reviewed
budget change). The firmware is tracked against the model at run time, log-only
for now, and an agreement test replays the HITL scenarios through it. Wiring
it up found two places where the model was wrong about the firmware, which is
the point.

The same attitude applies at two smaller scales:

- **Stacks.** A static bound over the shipped ELF's call graph
  (`//tools/stack_bound`) fails CI when any task's worst-case stack, with ISR
  context and a 25% margin, exceeds what it reserves. Measured high-water marks
  understate the paths a run did not take. The render task measured 0.8 KiB
  against a 7.4 KiB bound.
- **Data structures.** Kani proves the region allocators correct for every
  short operation sequence: slots never alias, alloc succeeds iff a slot is
  free, and the slab routes every free back to its class. It now runs
  hermetically as a Bazel test ([kani-bazel.md](design/kani-bazel.md)).

**What it costs.** The model is only as true as its cost table. We keep it
honest by deriving costs from `nm -S` and the measured core dump, and by
replacing each constant with `size_of` once a component moves into a region.
None of this is a proof of the firmware. It is a proof of the model, plus
tests that the firmware agrees with it.

## Why zero-copy protocol buffers?

The wire protocol is protobuf (`shared/protocol/proto/ledmapper.proto`), one
schema shared by the TypeScript app, the Python tools, the Rust firmware and
the agent bridge. Protobuf was the right choice for compatibility, but the
usual generated code is wrong for a microcontroller. A by-value decoded
message is sized by its _largest_ arm, and it lands on the stack of whatever
task handles the frame. One rarely used arm, the 4 KiB board-capabilities
catalog, made _every_ `ServerMessage` 4,104 bytes. That inflated every handler
frame on the hottest task.

`oss/pbview` generates borrowed _views_ instead. A view is two words that read
fields straight out of the received bytes, validated once, with no allocation,
no `unsafe` and no panics on any input. The firmware now dispatches every
request in place from the RX buffer (#265), and the firmware's own
`ServerMessage` is 656 bytes. pbview is self-contained under `oss/` because it
is useful to anyone doing protobuf on `no_std`.

## Why BLE and Wi-Fi at the same time?

It would be cheaper not to. Turning BLE off once a device has joined Wi-Fi was
the obvious memory lever, and we decided not to pull it. Requirement **PR-38**
(`requirements/requirements.yaml`) says the device keeps advertising and serves
a BLE central and a wss client concurrently, and that radio mutual exclusion is
not an allowed memory-reduction strategy. BLE is how a phone finds and
re-provisions a device that has lost its network, and it is the offline
control path (the BLE player transport, #154). A device that
goes deaf to BLE when it is busy is a device you have to power-cycle.

Writing the decision down as a requirement, with a HITL verification method,
means the next person trying to win back 30 KiB does not quietly undo it.

## Why a bytecode VM (and a JIT) for effects?

Effects are tiny GLSL-flavoured programs evaluated per LED, per frame
([EFFECTS.md](../EFFECTS.md)). They compile to `.fxb` bytecode and run on
`fx_vm`. We could have compiled effects to native firmware images or rendered
them on a host. We chose a VM because:

- **One VM, three hosts.** The same Rust VM runs on the C6, as wasm in the
  browser preview, and in the host golden tests. What you preview is,
  bit-for-bit, what the device renders.
- **Deploying an effect is a message, not a reflash.** A few hundred bytes over
  the control channel, checked against the device's budget before it is sent.
- **It is safe to accept programs from anywhere,** including an AI. The VM
  bounds its own execution and memory, and a bad program is refused with
  `bad_fxb` rather than crashing the player.
- **Costs are predictable.** Opcode costs are fitted from on-device cycle
  counts ([fx-vm-performance](fx-vm-performance.md)), so the editor and the
  agent can tell you whether an effect fits _before_ you deploy it.

The interpreter's dispatch overhead is real on a 160 MHz core, so hot
straight-line integer blocks are compiled at load time to RV32 machine code
(`firmware/fx_jit`). The JIT is checked by differential tests against the
interpreter and has the interpreter as its always-on fallback.

**What it costs.** A language and compiler to maintain, and an effect
vocabulary narrower than a desktop shader. In exchange we get uniforms with
names, ranges and units that any client can discover and drive.

## Why map with a phone camera?

Because the hard part of a 3D LED installation is not lighting it, it is
knowing where each LED ended up after someone wrapped it around a branch. The
controller blinks a self-clocking colour code that gives every LED a unique
temporal signature. You walk around the fixture with any phone, and a
visual-inertial solver recovers the camera path and every LED's position
together, metric-scaled and gravity-aligned, in a browser
(`solver/`, [led-mapper-design.md](../led-mapper-design.md)).

No ARCore, no LiDAR, no app install. That is what lets a non-technical person
map their own fixture. It is also why the solver, the CV pipeline and the
capture UX get so much attention: they are the product.

## Why so much hardware-in-the-loop testing?

Because a microcontroller's failure modes live in the hardware. They include
radio airtime, a watchdog, a strap pin sampled at reset and a USB bus shared by
two boards, and no host test sees any of them. The HITL rigs (`pi/hitl/`) are
Raspberry Pis with real ESP32-C6 boards, an access point, a logic analyzer and
real phones, reserved from a queue by CI. Every firmware PR flashes, provisions
over BLE and exercises a real device. The worst-case memory scenario
(`ram_audit`) watches the heap over JTAG without halting the core.

HITL is also how we learned humility about our own instruments. A
"provisioning hang" that got two good IRAM optimizations backed out turned out
to be the RAM watcher: a 46-second JTAG halt landing inside the Wi-Fi join,
followed by a watchdog reset that looked exactly like a firmware hang. Dumps
are now armed only after provisioning. The rule we took from it: when a
measurement and the system disagree, suspect the measurement too. Every HITL
failure ships with the device's serial log so the next person can tell.

**What it costs.** Rigs are hardware: they flake, they need redeploying, they
contend for airtime. A rig is also only one environment (the group-key bug
above passed on every rig). We treat a flaky rig as a bug to fix, not a test
to retry.

## Why Bazel and Nix?

The repo is a polyglot: TypeScript, Rust (native, `no_std` RISC-V and wasm),
C++ firmware, Python, Go and protobuf codegen for all of them. One
`bazel test //...` builds and tests all of it hermetically, and the same
graph produces the firmware image, the web app and the agent bundle in CI.
Nix supplies the toolchains that Bazel cannot fetch reproducibly by itself,
such as the ESP32 cross compilers and Arduino cores through `@embedded`.
Freshness gates keep generated artifacts (protocol bindings, the performance
doc, the user guide) from drifting from their sources.

**What it costs.** Bazel has a steep learning curve and a heavy first build,
and Nix is a hard prerequisite. We think that is the price of "builds the same
everywhere" for a project whose firmware, app and tools must agree byte for
byte.

## Why requirements-driven development?

Splanc's requirements, risks and their mitigations live in a machine-readable
model (`requirements/requirements.yaml`). Tests declare which requirements they
verify, and CI rolls them up into a report of what is validated, verified and
controlled ([requirements-driven-development.md](requirements-driven-development.md)).

This is unusual for a hobby-sized project. We do it because so much of the
system is a set of _negative_ promises that are easy to break by accident and
hard to notice: no heap growth, BLE stays up, an over-budget effect is refused,
a schema change can't drift between languages. A requirement with a test is
how a decision survives the next refactor.

## Why a thin device and a fat agent bridge?

The device speaks one narrow, versioned protocol and does as little as
possible beyond rendering: it advertises itself over mDNS (`_splanc._tcp`),
publishes a manifest at `/.well-known/splanc.json`, and accepts effects,
uniforms, a fixture pose and a time base. All of the intelligence lives off the
device in the agent bridge (`agent/`): discovery across the LAN, version
matching, compile and preview, budget checks, room-frame layout and clock
alignment across fixtures. The bridge is an MCP server and a one-shot CLI, so
"use splanc.io to set the mood of the room" works for an AI agent with a shell
and nothing configured ([agent-multi-fixture.md](design/agent-multi-fixture.md)).

Two rules shape that interface:

- **Names, not slots.** Uniforms are addressed by name, with documented ranges
  and units from the effect's own source comments. An agent never needs to know
  that `warmth` is slot 3.
- **Effects own the motion.** The client sets intent ("glide warmth to 0.8 over
  20 seconds"), and the device renders every frame. Fixtures share one time base
  so identical effects across a room stay in step (the target is under 20 ms of
  skew, measured on HITL with a logic analyzer).

**What it costs.** There is no LAN authentication today: anyone on the network
can drive the lights, and we say so in the agent's own instructions rather than
pretend otherwise. The agent surface also deliberately excludes rewiring,
remapping and calibration, which stay in the app where a human is looking.

## The common thread

Each of these decisions trades generality for a property we can check: memory
that is a constant, a state space that is enumerable, a stack that is bounded,
a protocol that cannot drift, a preview that is the render. An LED controller
is a small thing to be this careful about. It is also a thing people put in
their homes and expect to just work, and "just works for months" is a
property you have to design for. You cannot get it by debugging.
