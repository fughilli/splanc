# The wire protocol (`shared/protocol/`)

The single source of truth for every cross-module message. JSON schemas plus a
protobuf definition (`proto/ledmapper.proto`) describe the WebSocket control
messages, detection records, the output map, and the code-book parameters.
Codegen produces **TypeScript** types (consumed by the PWA) and **Python**
Pydantic models (consumed by the Pi server, reconstruction, and simulator), so
both halves of the system agree by construction.

## Key files

- `shared/protocol/schemas/*.json` — the authoritative JSON schemas.
- `shared/protocol/proto/ledmapper.proto` — the binary protocol.
- `shared/protocol/codegen.py` — regenerates the TS + Python bindings.
- `shared/protocol/python/ledmapper_protocol/_generated.py` — the generated
  Pydantic models (`OutputMap`, `LedEntry`, detection records, …).

## Freshness gate

The generated bindings are byte-pinned. A freshness check fails the build if they
drift from the schemas, so the protocol can't silently diverge from its codegen:

```sh
bazel test //shared/protocol:codegen_freshness
```

Adding a message or field means editing the schema / `.proto`, regenerating, and
committing the generated bindings together. Adding a new protocol _arm_ (an
optional accessor and the exhaustive matches that consume it) is a small,
well-worn change — see {doc}`../DEVELOPERS` for the build wiring.
