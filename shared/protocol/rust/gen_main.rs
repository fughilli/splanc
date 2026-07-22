//! micropb code-generation driver: FileDescriptorSet -> no_std Rust.
//!
//! Bazel-invoked (see BUILD.bazel): the descriptor set comes from the same
//! hermetic protoc genrule pattern the Python bindings use, so no protoc is
//! needed at generator runtime (`compile_fdset_file`).
//!
//! Container strategy (Phases 1/3 of docs/esp32-led-mapping-plan.md):
//! heapless fixed-capacity containers, generated in TWO PROFILES from the
//! same proto — the capacity tables below are the single place to change:
//!
//! - `host`: sized generously for the cross-language conformance test and
//!   for BUILDING large fixtures (the store tests encode 1024-LED uploads
//!   with the generated encoder). Envelope structs run to hundreds of KB of
//!   inline storage — fine on a host, meaningless on a microcontroller.
//! - `firmware`: sized for what a player actually decodes through the
//!   GENERATED bindings — control traffic only. The variable-size uploads
//!   (map, topology) never take this path on a player: the transport routes
//!   them through the arena decoder (ledmapper_store), so their collections
//!   shrink to capacity 1 and the whole ClientMessage envelope fits in a
//!   couple of KB. Pi-only telemetry arms (detections, imu_batch) also
//!   shrink to 1: players drop them, and the firmware decoder runs with
//!   `ignore_repeated_cap_err` so oversized repeats truncate instead of
//!   erroring.

use micropb_gen::{Config, Generator};

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || !matches!(args[3].as_str(), "host" | "firmware") {
        eprintln!("usage: {} <descriptor-set.bin> <out.rs> host|firmware", args[0]);
        std::process::exit(2);
    }
    let firmware = args[3] == "firmware";

    let mut g = Generator::new();
    g.use_container_heapless();

    // Defaults: every fixed-arity vector in the protocol (xyz, rgb, p, q, K,
    // Vec3.v) has <= 4 elements; strings (ids, enums-as-strings, timestamps)
    // fit 64 bytes.
    g.configure(".", Config::new().max_len(4).max_bytes(64));

    // Human-facing error text gets more room than identifier strings.
    g.configure(".ledmapper.v1.Error.message", Config::new().max_bytes(128));

    // Stored-map dump chunk: the player streams its map+topology back to the
    // phone a slice at a time; the payload must hold a control-frame-sized
    // chunk (the phone caps its request to this). 1 KiB fits the reply cap.
    g.configure(".ledmapper.v1.StoredMapChunk.data", Config::new().max_bytes(1024));

    // Batched telemetry (Pi-profile arms; players silently drop them).
    g.configure(
        ".ledmapper.v1.Detections.batch",
        Config::new().max_len(if firmware { 1 } else { 16 }),
    );
    g.configure(
        ".ledmapper.v1.ImuBatch.samples",
        Config::new().max_len(if firmware { 1 } else { 32 }),
    );

    // Map + solve preview collections: on the host, sized for a 1024-LED
    // fixture; on firmware these arms are never decoded through the
    // generated bindings (arena path / never sent to a player).
    g.configure_many(
        &[
            ".ledmapper.v1.OutputMap.leds",
            ".ledmapper.v1.OutputMap.unmapped",
            ".ledmapper.v1.SolveStatus.leds",
            ".ledmapper.v1.Topology.associations",
        ],
        Config::new().max_len(if firmware { 1 } else { 1024 }),
    );
    // Camera paths are decimated before upload; nothing on the player side
    // consumes them at all.
    g.configure_many(
        &[
            ".ledmapper.v1.OutputMap.trajectory",
            ".ledmapper.v1.SolveStatus.trajectory",
        ],
        Config::new().max_len(if firmware { 1 } else { 512 }),
    );

    // Topology skeleton: branch points / segments are orders of magnitude
    // fewer than LEDs; polylines are decimated. NOTE these two multiply
    // (polyline storage is inline PER SEGMENT), so they dominate the size of
    // the host envelope structs.
    g.configure(
        ".ledmapper.v1.Topology.branch_points",
        Config::new().max_len(if firmware { 1 } else { 64 }),
    );
    g.configure(
        ".ledmapper.v1.Topology.segments",
        Config::new().max_len(if firmware { 1 } else { 32 }),
    );
    g.configure(
        ".ledmapper.v1.TopologySegment.polyline",
        Config::new().max_len(if firmware { 1 } else { 64 }),
    );

    // Rendered-frame timing drain (get_frame_timing): REAL firmware traffic —
    // the player ENCODES this reply, so the cap bounds how many ticks ride one
    // poll; the rest wait for the next poll (the ring buffers them, no loss).
    // Kept modest on firmware because FrameTiming is a ServerMessage variant
    // built by value on the loopTask stack in Player::handle — an oversized
    // cap inflates every ServerMessage temporary there. Host gets more room
    // for the drain tests.
    g.configure(
        ".ledmapper.v1.FrameTiming.ticks",
        Config::new().max_len(if firmware { 24 } else { 128 }),
    );

    // Counting + playback control: REAL firmware traffic — full size in
    // both profiles.
    g.configure(
        ".ledmapper.v1.SetCountingPattern.blocks",
        Config::new().max_len(32),
    );
    g.configure(".ledmapper.v1.PlaybackParams.palette", Config::new().max_len(16));

    g.compile_fdset_file(&args[1], &args[2])
}
