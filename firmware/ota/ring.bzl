"""Keyring header command (gen_key_header.py --key ID=path ...)."""

def ring_cmd(ring, lang = "cpp", tool = ":gen_key_header"):
    """The genrule cmd that writes the keyring `ring` ({id: .pub label}) to $@.

    A C++ header (the C6 loader) or, with lang = "rust", a Rust const (the MAX
    updater, //pi/max_ota).

    Args:
      ring: {key id: .pub file label}.
      lang: "cpp" or "rust".
      tool: the gen_key_header label.

    Returns:
      The genrule cmd.
    """
    return "$(execpath %s) --lang %s " % (tool, lang) + " ".join([
        "--key %s=$(location %s)" % (kid, ring[kid])
        for kid in sorted(ring.keys())
    ]) + " --out $@"

# The Splanc MAX (Raspberry Pi) updater's ring (docs/design/max-ota.md "Signing"):
# its OWN key id 3, never the loader ring's 0/1/2, so a C6 image can't install on a
# MAX and a MAX key can't sign C6 firmware. //pi/max_ota generates it with
# ring_cmd(..., lang = "rust").
MAX_RELEASE_RING = {
    "3": "//firmware/ota:keys/max.pub",
}

MAX_TEST_RING = {
    "3": "//firmware/ota:keys/test_max.pub",
}
