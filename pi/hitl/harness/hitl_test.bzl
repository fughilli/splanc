"""hitl_test — fan a single on-hardware test out to one target per compatible SKU.

Given `requires = [caps]`, this emits a `hitl`-tagged py_test `<name>_<sku>` for
every SKU in the registry (//pi/hitl:skus.bzl) whose capabilities are a superset of
`requires`. The CI lane's query — `attr(tags, "\\bhitl\\b", tests(//...))` — picks
them all up unchanged, so each test runs on every hardware type that satisfies it.
A hardware-specific test (`requires = ["jtag"]`) fans to just esp32c6; a contract
test (`requires = ["improv"]`) fans to esp32c6 + led-mapper-pi + any future SKU with
`improv`. Each variant is passed `--sku=<sku>` (branch setup) and
`--require-caps=<caps>` (reserve any free DUT that satisfies it).
"""

load("@rules_python//python:defs.bzl", "py_test")
load("//pi/hitl:skus.bzl", "hitl_skus_with")

def hitl_test(name, srcs, main, requires, data = [], deps = [], args = [], **kwargs):
    """Emit one `hitl`+`manual`-tagged py_test per SKU whose caps ⊇ `requires`.

    Args:
      name: base name; variants are `<name>_<sku>`.
      srcs: sources, forwarded to each generated py_test.
      main: entry-point script, forwarded to each generated py_test.
      requires: capabilities the test needs (drives which SKUs it fans to).
      data: runtime data deps, forwarded to each generated py_test.
      deps: library deps, forwarded to each generated py_test.
      args: base args; each variant additionally gets `--sku` + `--require-caps`.
      **kwargs: extra py_test attrs (forwarded).
    """
    skus = hitl_skus_with(requires)
    if not skus:
        fail("hitl_test(%s): no SKU in //pi/hitl:skus.bzl provides caps %s" % (name, requires))
    caps_arg = "--require-caps=" + ",".join(requires)
    for sku in skus:
        py_test(
            name = name + "_" + sku,
            srcs = srcs,
            main = main,
            data = data,
            deps = deps,
            args = args + ["--sku=" + sku, caps_arg],
            imports = ["."],
            timeout = "eternal",  # a flash + provision cycle runs minutes
            tags = ["hitl", "manual"],
            **kwargs
        )
