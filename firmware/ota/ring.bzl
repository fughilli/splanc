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
# its OWN key ids, never the loader ring's 0/1/2, so a C6 image can't install on a
# MAX and a MAX key can't sign C6 firmware. //pi/max_ota generates it with
# ring_cmd(..., lang = "rust").
#   3 `max`        online: the MAX_OTA_SIGNING_KEY secret signs every MAX release.
#   4 `max_backup` OFFLINE (cold storage, never in CI): signs the key-epoch record
#                  that revokes a compromised `max`, and the bridge image that
#                  carries its replacement ("Key rotation").
# An UNSET .pub is an entry that verifies nothing (the build still works).
MAX_RELEASE_RING = {
    "3": "//firmware/ota:keys/max.pub",
    "4": "//firmware/ota:keys/max_backup.pub",
}

# The TEST counterparts (public keys, HITL / development): test_max + test_max_backup.
MAX_TEST_RING = {
    "3": "//firmware/ota:keys/test_max.pub",
    "4": "//firmware/ota:keys/test_max_backup.pub",
}
