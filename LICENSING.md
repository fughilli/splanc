# Licensing

Splanc is **free and open-source software**. Most of the repository is licensed
under the **GNU Affero General Public License, version 3.0** (AGPL-3.0). Two
subtrees — the wire protocol and the TouchDesigner client binding — are carved
out under the permissive **MIT License** so that anyone can build interoperable
clients, servers, and tools without the AGPL's network-copyleft obligations.

Copyright © 2026 Fughilli Industries, LLC.

## The map

| Path                   | License                                 | What                                                                                                                  |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| _(repository default)_ | **AGPL-3.0-only**                       | The Splanc application: web app, firmware, Pi server, solver, tools.                                                  |
| `shared/protocol/`     | **MIT** (`shared/protocol/LICENSE`)     | The LED Mapper wire protocol: JSON Schemas, `ledmapper.proto`, and the generated TypeScript / Python / Rust bindings. |
| `tools/touchdesigner/` | **MIT** (`tools/touchdesigner/LICENSE`) | The TouchDesigner client binding: Rust protocol core, C++ TOP/CHOP shims, and packaging.                              |

If a subtree contains its own `LICENSE` file, that license governs everything in
that subtree, and it takes precedence over the repository default for those
files. Everything not covered by a subtree `LICENSE` is AGPL-3.0-only, as stated
in the top-level [`LICENSE`](./LICENSE).

## Why this split

The AGPL keeps the application itself open: anyone who runs a modified Splanc as
a network service must offer their users the corresponding source. The wire
protocol and the reference client bindings, by contrast, exist to be reused — a
protocol is only useful if people can freely implement it. Licensing those under
MIT lets third parties build compatible controllers, drivers, and integrations
(including closed-source or commercial ones) against the same `ledmapper.v1`
protocol the phone/web app speaks.

## Contributing

Contributions are accepted under a Contributor License Agreement — see
[`CLA.md`](./CLA.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md). The CLA lets the
Company keep this licensing coherent (including moving code between the AGPL and
MIT subtrees) and relicense the work where needed.

## SPDX identifiers

- Repository default: `AGPL-3.0-only`
- `shared/protocol/` and `tools/touchdesigner/`: `MIT`
