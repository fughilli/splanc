//! micropb code-generation driver: FileDescriptorSet -> no_std Rust.
//!
//! Bazel-invoked (see BUILD.bazel): the descriptor set comes from the same
//! hermetic protoc genrule pattern the Python bindings use, so no protoc is
//! needed at generator runtime (`compile_fdset_file`).
//!
//! Container strategy (Phase 1 of docs/esp32-led-mapping-plan.md): heapless
//! fixed-capacity containers with capacities sized generously for the
//! cross-language conformance test and for phone->player uploads. Phase 3
//! rebinds the large variable-size collections (map, topology) to the
//! firmware arena; these static capacities are the interim, host-testable
//! binding, and the single place to change them.

use micropb_gen::{Config, Generator};

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: {} <descriptor-set.bin> <out.rs>", args[0]);
        std::process::exit(2);
    }

    let mut g = Generator::new();
    g.use_container_heapless();

    // Defaults: every fixed-arity vector in the protocol (xyz, rgb, p, q, K,
    // Vec3.v) has <= 4 elements; strings (ids, enums-as-strings, timestamps)
    // fit 64 bytes.
    g.configure(".", Config::new().max_len(4).max_bytes(64));

    // Human-facing error text gets more room than identifier strings.
    g.configure(".ledmapper.v1.Error.message", Config::new().max_bytes(128));

    // Batched telemetry (Pi-profile arms; a player never stores these).
    g.configure(".ledmapper.v1.Detections.batch", Config::new().max_len(16));
    g.configure(".ledmapper.v1.ImuBatch.samples", Config::new().max_len(32));

    // Map + solve preview collections: sized for a 1024-LED fixture.
    g.configure_many(
        &[
            ".ledmapper.v1.OutputMap.leds",
            ".ledmapper.v1.OutputMap.unmapped",
            ".ledmapper.v1.SolveStatus.leds",
            ".ledmapper.v1.Topology.associations",
        ],
        Config::new().max_len(1024),
    );
    // Camera paths are decimated before upload; firmware never consumes
    // them, so the cap only needs to admit the conformance fixtures and keep
    // the envelope structs sane (they are inline heapless storage).
    g.configure_many(
        &[
            ".ledmapper.v1.OutputMap.trajectory",
            ".ledmapper.v1.SolveStatus.trajectory",
        ],
        Config::new().max_len(512),
    );

    // Topology skeleton: branch points / segments are orders of magnitude
    // fewer than LEDs; polylines are decimated. NOTE these two multiply
    // (polyline storage is inline PER SEGMENT), so they dominate the size of
    // the envelope structs — keep the product small until the Phase 3 arena
    // rebind replaces inline storage for the variable-size collections.
    g.configure(".ledmapper.v1.Topology.branch_points", Config::new().max_len(64));
    g.configure(".ledmapper.v1.Topology.segments", Config::new().max_len(32));
    g.configure(
        ".ledmapper.v1.TopologySegment.polyline",
        Config::new().max_len(64),
    );

    // Counting + playback control.
    g.configure(
        ".ledmapper.v1.SetCountingPattern.blocks",
        Config::new().max_len(32),
    );
    g.configure(".ledmapper.v1.PlaybackParams.palette", Config::new().max_len(16));

    g.compile_fdset_file(&args[1], &args[2])
}
