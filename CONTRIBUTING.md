# Contributing to Splanc

Thanks for wanting to contribute! This document covers the **legal and process**
side of contributing. For how the repo is built, tested, and laid out, see
[`DEVELOPERS.md`](./DEVELOPERS.md).

## Licensing of your contributions

Splanc is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0), with two subtrees carved out under the **MIT License** — the wire
protocol (`shared/protocol/`) and the TouchDesigner client binding
(`tools/touchdesigner/`). See [`LICENSING.md`](./LICENSING.md) for the full map.

When you contribute, your contribution is licensed under the license that
applies to the file(s) you touch: AGPL-3.0 for the application, MIT for the
carved-out protocol/binding subtrees.

## Contributor License Agreement (CLA)

Before we can merge your contribution, you must agree to our
[Contributor License Agreement](./CLA.md). The CLA grants Fughilli Industries,
LLC the rights it needs to keep the project's licensing coherent (including the
AGPL/MIT split) and to relicense the work — for example, to offer it under
commercial terms to users who cannot accept copyleft.

Agreeing is lightweight. Until an automated CLA check is in place, add the
following line to your **first** pull request description (or as a commit
trailer), filled in with your details:

```text
I have read the CLA and I agree to it: Your Name <you@example.com>
```

Contributing on behalf of a company? Your employer should execute a Corporate
CLA — contact the maintainers first.

## Pull requests

- Branch off `main`, keep changes focused, and describe what and why.
- Run the checks before you push: `pre-commit run --all-files` (or `prek run
--all-files`) and the relevant Bazel tests. See [`DEVELOPERS.md`](./DEVELOPERS.md)
  for the specifics.
- If your change touches the wire protocol (`shared/protocol/`), regenerate the
  bindings and keep the schemas as the source of truth (see
  [`shared/protocol/README.md`](./shared/protocol/README.md)).

By submitting a pull request, you certify that you have read the
[CLA](./CLA.md) and agree to its terms for your present and future
contributions.
