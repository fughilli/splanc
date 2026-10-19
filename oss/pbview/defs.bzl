"""pbview_library: zero-copy protobuf views generated from a descriptor set."""

load("@rules_rust//rust:defs.bzl", "rust_library")

def pbview_library(name, fdset, crate_name = None, visibility = None, **kwargs):
    """A no_std Rust crate of pbview views for every file in `fdset`.

    Args:
      name: target name.
      fdset: label of a protoc `--descriptor_set_out` FileDescriptorSet.
      crate_name: crate name (default: `name`).
      visibility: visibility of the library.
      **kwargs: passed to rust_library.
    """
    gen = name + "_gen"
    native.genrule(
        name = gen,
        srcs = [fdset],
        outs = [name + ".rs"],
        cmd = "$(execpath //oss/pbview:pbview_gen) $(location " + fdset + ") $@ --crate-root",
        tools = ["//oss/pbview:pbview_gen"],
    )
    rust_library(
        name = name,
        srcs = [":" + gen],
        crate_root = ":" + gen,
        crate_name = crate_name,
        edition = "2021",
        deps = ["//oss/pbview:pbview"],
        visibility = visibility,
        **kwargs
    )
