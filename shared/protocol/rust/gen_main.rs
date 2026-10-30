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
    // Solver quality warnings are sentences, not identifiers. The firmware
    // store skips OutputMap.stats on upload, so the device never holds them.
    g.configure(
        ".ledmapper.v1.OutputMapStats.warnings",
        Config::new()
            .max_len(if firmware { 1 } else { 8 })
            .max_bytes(if firmware { 1 } else { 512 }),
    );

    // Stored-map dump chunk: the player streams its map+topology back to the
    // phone a slice at a time; the payload holds a control-frame-sized chunk (the
    // phone caps its request to this). On HOST the generated encoder builds it, so
    // it needs the full 1 KiB. On FIRMWARE the player encodes this reply ZERO-COPY
    // straight to the output (ffi.rs handle_get_stored_map) and never materializes
    // the struct, so the inline buffer is dead weight that would size every
    // ServerMessage temporary to ~1 KiB — shrink it to a stub.
    g.configure(
        ".ledmapper.v1.StoredMapChunk.data",
        Config::new().max_bytes(if firmware { 8 } else { 1024 }),
    );

    // Sharded upload window. On firmware the player NEVER decodes UploadChunk
    // through the generated bindings — the transport intercepts the arm and
    // hand-walks the payload straight into the reassembly buffer (like the
    // arena upload arms), so the generated field shrinks to 1. The host
    // profile sizes it for the conformance/golden encode of a real window.
    g.configure(
        ".ledmapper.v1.UploadChunk.payload",
        Config::new().max_bytes(if firmware { 1 } else { 8192 }),
    );

    // Batched telemetry (Pi-profile arms; players silently drop them).
    g.configure(
        ".ledmapper.v1.Detections.batch",
        Config::new().max_len(if firmware { 1 } else { 16 }),
    );
    g.configure(
        ".ledmapper.v1.ImuBatch.samples",
        Config::new().max_len(if firmware { 1 } else { 32 }),
    );

    // Map + solve preview collections: on the host, sized past the firmware's
    // 2048-LED cap (tests feed maps a little past it; heapless Vecs live inline,
    // so much more overflows host test stacks); was a 1024-LED
    // fixture; on firmware these arms are never decoded through the
    // generated bindings (arena path / never sent to a player).
    g.configure_many(
        &[
            ".ledmapper.v1.OutputMap.leds",
            ".ledmapper.v1.OutputMap.unmapped",
            ".ledmapper.v1.SolveStatus.leds",
            ".ledmapper.v1.Topology.associations",
        ],
        Config::new().max_len(if firmware { 1 } else { 2560 }),
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

    // Counting pattern: on HOST the generated decoder is driven by the session
    // test / conformance, so keep 32 blocks. On FIRMWARE the player decodes this
    // arm ZERO-COPY (ffi.rs handle_set_counting_pattern) into pre-reduced blocks
    // and never touches the generated struct, whose Vec<ColorBlock, 32> (each an
    // inline Vec<f64, 4>) is the ~1.5 KiB arm that sizes every ClientMessage —
    // shrink it to a stub so ClientMessage collapses to a control-frame size.
    g.configure(
        ".ledmapper.v1.SetCountingPattern.blocks",
        Config::new().max_len(if firmware { 1 } else { 32 }),
    );
    g.configure(".ledmapper.v1.PlaybackParams.palette", Config::new().max_len(16));

    // Declared texture inputs echoed in the effect_uniforms reply: REAL
    // firmware traffic (the player ENCODES this). An effect declares only a
    // handful of texture buffers; 8 covers any realistic effect in both
    // profiles.
    g.configure(".ledmapper.v1.EffectUniforms.textures", Config::new().max_len(8));
    // The effect's uniform manifest (compiler JSON) + one live value per uniform.
    // The firmware encodes this reply ZERO-COPY (ffi.rs handle_get_effect_uniforms,
    // the manifest spliced straight from the .fxb), so its profile stubs both; the
    // host profile decodes a real effect's manifest (bounded by the 4 KiB .fxb).
    g.configure(
        ".ledmapper.v1.EffectUniforms.manifest",
        Config::new().max_bytes(if firmware { 1 } else { 4096 }),
    );
    g.configure(
        ".ledmapper.v1.EffectUniforms.current",
        Config::new().max_len(if firmware { 1 } else { 64 }),
    );

    // Static board capabilities the firmware ENCODES into hardware_config_state.
    // The C6 has GPIO0..30, so 31 pins covers the worst case; a handful of LED
    // driver modes is plenty.
    g.configure(
        ".ledmapper.v1.BoardCapabilities.gpio_pins",
        Config::new().max_len(31),
    );
    g.configure(
        ".ledmapper.v1.BoardCapabilities.led_modes",
        Config::new().max_len(6),
    );
    // ...but the FIRMWARE never materializes that struct: it keeps the embedded
    // descriptor encoded and splices it into the reply (Player::encode_reply).
    // Inline, this ~4 KiB field sized EVERY by-value ServerMessage on the
    // handler stacks, so the firmware profile drops it from the envelope.
    if firmware {
        g.configure(
            ".ledmapper.v1.HardwareConfigState.board",
            Config::new().skip(true),
        );
    }

    // Welcome.features: a handful of short feature names. The firmware splices its
    // static list in at encode time (Player::encode_reply, like the board
    // descriptor), so its profile drops the field instead of carrying ~150 B of
    // inline strings in every by-value ServerMessage.
    if firmware {
        g.configure(".ledmapper.v1.Welcome.features", Config::new().skip(true));
    } else {
        g.configure(
            ".ledmapper.v1.Welcome.features",
            Config::new().max_len(32).max_bytes(32),
        );
    }

    // Fixture pose: a short room name + four small float vectors (the default
    // max_len 4 fits xyz / a quaternion). The firmware splices welcome.pose at
    // encode time from the player's stored pose (like features), so its profile
    // drops the inline copy from every by-value ServerMessage.
    g.configure(".ledmapper.v1.FixturePose.room", Config::new().max_bytes(32));
    if firmware {
        g.configure(".ledmapper.v1.Welcome.pose", Config::new().skip(true));
    }

    // Uniform keypoints (docs/design/uniform-keypoints.md). The firmware reads the
    // requests IN PLACE (pbview) and encodes both replies zero-copy (ffi.rs), so its
    // profile drops every repeated field from the by-value envelopes; the host
    // profile carries a full effect's worth (16 keypoints, 32 uniforms).
    g.configure(".ledmapper.v1.KeypointInfo.name", Config::new().max_bytes(32));
    g.configure(".ledmapper.v1.Keypoint.name", Config::new().max_bytes(32));
    g.configure(".ledmapper.v1.KeypointValue.uniform", Config::new().max_bytes(24));
    for (field, host_len) in [
        (".ledmapper.v1.KeypointList.keypoints", 16),
        (".ledmapper.v1.Keypoint.values", 32),
        (".ledmapper.v1.Keypoint.slots", 32),
        (".ledmapper.v1.SaveKeypoint.values", 32),
        (".ledmapper.v1.BlendKeypoints.weights", 4),
    ] {
        if firmware {
            g.configure(field, Config::new().skip(true));
        } else {
            g.configure(field, Config::new().max_len(host_len));
        }
    }

    // Firmware update (docs/design/ota.md). Neither firmware image decodes or encodes
    // these through the generated bindings: the app and the loader intercept the OTA
    // arms and use the hand-coded codec in //firmware/ota (wire.rs, cross-checked
    // against the host profile by //firmware/ota:wire_test). So the firmware profile
    // stubs every variable-size field (and drops welcome.ota, which only the loader
    // sends); the host profile sizes them for a real manifest / chunk / status.
    g.configure(
        ".ledmapper.v1.OtaBegin.manifest",
        Config::new().max_bytes(if firmware { 1 } else { 108 }),
    );
    g.configure(
        ".ledmapper.v1.OtaBegin.key_epoch",
        Config::new().max_bytes(if firmware { 1 } else { 80 }),
    );
    // Splanc MAX (docs/design/max-ota.md): the player decodes OTA arms with the host
    // profile; the C6 never reads source_url and never sends board.
    g.configure(
        ".ledmapper.v1.OtaBegin.source_url",
        Config::new().max_bytes(if firmware { 1 } else { 1024 }),
    );
    g.configure(
        ".ledmapper.v1.OtaStatus.board",
        Config::new().max_bytes(if firmware { 1 } else { 16 }),
    );
    g.configure(
        ".ledmapper.v1.OtaChunk.data",
        Config::new().max_bytes(if firmware { 1 } else { 4096 }),
    );
    for field in [
        ".ledmapper.v1.OtaStatus.error",
        ".ledmapper.v1.OtaStatus.app_fw_version",
        ".ledmapper.v1.OtaStatus.loader_reason",
        ".ledmapper.v1.OtaStatus.last_result",
    ] {
        g.configure(field, Config::new().max_bytes(if firmware { 1 } else { 64 }));
    }
    // Welcome.ota is skipped in BOTH profiles: Welcome sits inside every by-value
    // ServerMessage, and an inline OtaStatus (4 strings) there grew the host test
    // stacks past their limit. Nothing Rust-side reads it (wire_test decodes it from
    // the raw welcome bytes).
    g.configure(".ledmapper.v1.Welcome.ota", Config::new().skip(true));
    // Sensor core (docs/design/sensor-core.md): the firmware encodes SensorState
    // ZERO-COPY (ffi.rs handle_get_sensors), so its profile drops the vectors and
    // strings from the by-value ServerMessage; the host profile keeps them (xyz /
    // a quaternion fit the default max_len 4).
    if firmware {
        for field in [
            "part", "accel", "gyro", "quat", "gravity", "linear_accel", "gyro_bias",
            "calibration_result",
        ] {
            g.configure(&format!(".ledmapper.v1.SensorState.{field}"), Config::new().skip(true));
        }
        // Driver VM (FUG-107): replies encoded zero-copy too; the request's fxb
        // is read in place (pbview).
        for field in [
            ".ledmapper.v1.I2cScanResult.addresses",
            ".ledmapper.v1.DriverState.exports",
            ".ledmapper.v1.DriverState.last_poll",
            ".ledmapper.v1.SubmitDriver.fxb",
            ".ledmapper.v1.SensorState.rest_up_imu",
            ".ledmapper.v1.SensorState.mount_quat",
            ".ledmapper.v1.CaptureProfile.map_id",
        ] {
            g.configure(field, Config::new().skip(true));
        }
    } else {
        g.configure(".ledmapper.v1.SensorState.part", Config::new().max_bytes(32));
        g.configure(".ledmapper.v1.SensorState.calibration_result", Config::new().max_bytes(16));
        g.configure(".ledmapper.v1.I2cScanResult.addresses", Config::new().max_len(112));
        g.configure(".ledmapper.v1.DriverState.exports", Config::new().max_len(8));
        g.configure(".ledmapper.v1.DriverExport.name", Config::new().max_bytes(24));
        g.configure(".ledmapper.v1.DriverState.last_poll", Config::new().max_bytes(16));
        g.configure(".ledmapper.v1.SubmitDriver.fxb", Config::new().max_bytes(1024));
        g.configure(".ledmapper.v1.CaptureProfile.map_id", Config::new().max_bytes(64));
    }
    // FX debugger (docs/design/fx-debugger.md): the firmware writes all three
    // replies ZERO-COPY (ffi.rs fxdbg_*), streaming sections straight from the
    // live buffers, so its profile drops every variable-size field from the
    // by-value ServerMessage; the host profile sizes them for a real reply.
    for (field, host_len, bytes) in [
        (".ledmapper.v1.FxDebugState.decks", 2, false),
        (".ledmapper.v1.FxDebugState.color_order", 6, true),
        (".ledmapper.v1.FxDebugState.frame_ctx", 256, true),
        (".ledmapper.v1.FxDebugState.resume_reason", 16, true),
        (".ledmapper.v1.FxSnapshotChunk.data", 1024, true),
        (".ledmapper.v1.FxLedDebug.rgb", 3, true),
        (".ledmapper.v1.FxLedDebug.rgb_jit", 3, true),
        (".ledmapper.v1.FxLedDebug.output", 3, true),
        (".ledmapper.v1.FxLedDebug.locals", 128, false),
        (".ledmapper.v1.FxLedDebug.led_context", 64, true),
    ] {
        if firmware {
            g.configure(field, Config::new().skip(true));
        } else if bytes {
            g.configure(field, Config::new().max_bytes(host_len));
        } else {
            g.configure(field, Config::new().max_len(host_len));
        }
    }

    g.compile_fdset_file(&args[1], &args[2])
}
