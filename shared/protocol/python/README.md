# ledmapper-protocol

Pydantic v2 models for the LED Mapper wire protocol.

These models are generated from the JSON Schema set under
`shared/protocol/schemas/`. See `shared/protocol/README.md` for how to
regenerate them and how the contracts map to the design doc (§7).

## Install (editable)

```text
pip install -e shared/protocol/python
```

## Usage

```python
from ledmapper_protocol import DetectionRecord, ClientMessage, ServerMessage
```
