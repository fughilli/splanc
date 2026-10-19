# pbview — zero-copy protobuf views for `no_std`

`pbview` reads protobuf messages **straight from their wire bytes**. Instead of
decoding into a struct, the generator emits a _view_ per message: a borrowed
`&[u8]` with one lazy accessor per field. Strings and bytes come back as
borrows of the input, nested messages as further views, repeated fields as
iterators over the buffer, and a oneof as a borrowed enum you `match` on.

It was built for a heap-starved microcontroller (ESP32-C6) where by-value
generated structs were the problem: every decoded envelope is sized by its
_largest_ possible arm, with inline capacity for every repeated field, and it
lands on the stack of whatever task handles the frame. A view is two words,
whatever the schema.

```rust
let env = ClientMessageView::parse(rx_frame)?;      // validates once, copies nothing
match env.msg() {
    Some(client_message::Msg::Hello(h)) => greet(h.client(), h.app_version()),
    Some(client_message::Msg::SubmitMap(m)) => {
        let map = m.map().unwrap();
        for led in map.leds() {                       // iterates the frame in place
            store(led.id(), led.xyz());               // xyz: packed doubles, read lazily
        }
    }
    _ => {}
}
```

## What you get

- **No allocation, no copy, no `unsafe`** (`#![forbid(unsafe_code)]`), `no_std`.
- **`parse` validates once** (framing, wire types per the schema, UTF-8,
  packed runs, nesting depth ≤ `DEFAULT_MAX_DEPTH`), so accessors on a parsed
  view never silently skip anything. `new_unchecked` skips it; accessors stay
  bounds-safe and simply stop at malformed data. Nothing panics on any input
  (fuzz-tested).
- **No capacity limits.** There is nothing to size, so nothing truncates.
- **Protobuf semantics**: last occurrence wins for singular scalars; packed and
  unpacked repeated encodings (and mixtures) are both accepted; unknown fields
  are skipped; proto3 enums stay open (raw `i32` + a generated
  `#[repr(i32)]` enum with `TryFrom<i32>`); proto3 `optional` and message
  fields have presence (`Option`).
- **Single-pass access**: `view.fields()` yields a typed `AnyField` per wire
  field, for hot paths that read most of a message.
- **Encoding**: `Writer` writes into a `&mut [u8]`; `Writer::message` writes a
  nested message in place and backpatches its length (one in-buffer move when
  the body exceeds 127 bytes), so replies need no by-value struct either.

## Design: lazy accessors

Each accessor re-scans the message's top level (O(fields) per call, zero extra
state). For control-sized messages that read a handful of fields this beats
building an offset index (whose size grows with the field count and would
land on the stack again). Code that reads most fields of a large message uses
the single-pass `fields()` iterator instead.

Deliberate deviation: a singular _message_ field that occurs more than once is
not merged (protobuf merges); the last occurrence wins. Groups are rejected.

## Using it

The generator reads a `FileDescriptorSet` (`protoc --descriptor_set_out`) and
needs nothing else — it parses descriptors with `pbview` itself.

**Bazel** (`rules_rust`):

```starlark
load("//oss/pbview:defs.bzl", "pbview_library")

pbview_library(name = "my_views", fdset = ":my_proto_fdset")
```

**Cargo**: run `protoc --descriptor_set_out=…` in your build, then in
`build.rs`:

```rust
let fdset = std::fs::read(fdset_path)?;
let code = pbview_gen::generate(&fdset, &pbview_gen::Options::default())?;
std::fs::write(out_dir.join("views.rs"), code)?;
```

and `include!(concat!(env!("OUT_DIR"), "/views.rs"));`. Or use the CLI:
`pbview-gen descriptor_set.bin views.rs [--crate-root] [--runtime PATH]`.

Generated layout: package `a.b` becomes `mod a { mod b { … } }`; message `Foo`
becomes `FooView<'a>`, with its nested types, oneof enums and `AnyField` in
`mod foo`. Field accessors are `snake_case` (Rust keywords as raw identifiers).

## Tests

- `runtime_test`: varints, zigzag, every scalar kind, last-wins, packed/unpacked
  mixes, the writer's length backpatching across varint size boundaries, and
  20k random buffers through every reader.
- `conformance_test`: views over **protoc's own encoding** of a message
  covering every field kind (all 15 scalar types, optional, repeated
  packed/unpacked, strings, bytes, nested and recursive messages, maps, a
  oneof, enums, keyword field names); every truncation of it; mistyped and
  non-UTF-8 fields; the nesting limit; 5k mutated encodings through every
  accessor, parsed and unchecked.

## Status

Extracted from the splanc firmware; license to be decided (see `LICENSE`).
MSRV 1.80. Not yet on crates.io.
