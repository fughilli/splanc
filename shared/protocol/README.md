# shared/protocol (M10)

Single source of truth for the LED Mapper wire formats. The contracts are
defined in JSON Schema (Draft 2020-12); language bindings for TypeScript and
Pydantic v2 are generated from those schemas. Nothing else in the repo should
hand-redefine any of these types.

See `led-mapper-design.md` §7 for the normative spec.

## Layout

```text
shared/protocol/
  schemas/                       # JSON Schemas (the source of truth)
    detection_record.json        # §7.4
    code_params.json             # §7.6
    output_map.json              # §7.5
    client_messages.json         # §7.1 (discriminated union on `type`)
    server_messages.json         # §7.2 (discriminated union on `type`)
  ts/                            # Generated TS types (consumed by the web app)
    index.ts
    package.json                 # @ledmapper/protocol
  python/                        # Generated Pydantic v2 models
    ledmapper_protocol/__init__.py
    pyproject.toml               # ledmapper-protocol
  tests/
    test_roundtrip.py            # M10 acceptance test (§6)
  codegen.py                     # Regenerates ts/ and python/ from schemas/
```

## Regenerating the bindings

After editing anything under `schemas/`:

```text
python3 shared/protocol/codegen.py
```

To verify in CI that the generated files are up to date:

```text
python3 shared/protocol/codegen.py --check
```

## Importing

### Python (Pi server, reconstruction, simulator)

```text
pip install -e shared/protocol/python
```

```python
from ledmapper_protocol import (
    DetectionRecord,
    ClientMessage,
    ServerMessage,
    OutputMap,
    CodeParams,
)
```

All models have `extra='forbid'` set, so unknown fields raise
`pydantic.ValidationError`. This is intentional: the protocol package exists
to surface contract drift, not to paper over it.

The discriminated unions `ClientMessage` and `ServerMessage` are
`RootModel`s. To construct one, pass the variant in directly
(`ClientMessage(HelloMessage(...))`); to parse one off the wire, use
`ClientMessage.model_validate_json(text)` and read `.root`.

### TypeScript (web app, Vite)

The package ships `.ts` directly — no build step. The web app imports it as
a workspace package:

```ts
import type {
  DetectionRecord,
  ClientMessage,
  ServerMessage,
  CodeParams,
  OutputMap,
} from '@ledmapper/protocol';
```

Wire it up in the web app's `package.json` via a workspace dependency on
`@ledmapper/protocol` pointing at `../shared/protocol/ts`.

## Running the round-trip test

```text
pip install -e shared/protocol/python
pytest shared/protocol/tests
```

The test constructs an example of every type and every message variant from
§7, serializes to JSON, deserializes, and asserts equality. It also asserts
that unknown fields and unknown message `type`s are rejected.

## Conventions enforced by the schemas

- All times are milliseconds (numbers).
- Quaternions are `[x, y, z, w]`.
- `K` is `[fx, fy, cx, cy]`.
- `pose` is `{ p: [x,y,z], q: [x,y,z,w] }`.
- `cycleFrames = 2 + bits`.
- `encoding` and `syncPattern` are string enums (`"gray"`, `"on_off"`),
  modeled as enums so they can grow without breaking the wire contract.

## License

This directory — the LED Mapper wire protocol and its language bindings — is
licensed under the **MIT License** (see [`LICENSE`](./LICENSE)), a deliberate
carve-out from the AGPL-3.0 that covers the rest of the repository. The wire
contract is meant to be reused: anyone may build interoperable clients,
servers, or tools against it without the copyleft obligations that apply to the
Splanc application. See the repository's [`LICENSING.md`](../../LICENSING.md)
for the full map.
