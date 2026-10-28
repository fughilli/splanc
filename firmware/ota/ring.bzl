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

# The OTA signing keyring (docs/design/ota.md "Key rotation"), the ONE source for
# both the C6 loader (//firmware/ota:ota_key_h, C++) and the Splanc MAX updater
# (//pi/max_ota:ring_rs, Rust): the MAX trusts the same keys (docs/design/max-ota.md
# "Signing"). The signed board field (flags bits 24..31) keeps their images apart.
#   0 `release` online: the OTA_SIGNING_KEY secret signs every C6 and MAX release.
#   1 `backup`  OFFLINE (cold storage, never in CI): signs key-epoch records that
#               revoke a compromised `release`, and bridge images.
#   2 `next`    a planned successor (UNSET until committed).
#   3, 4        RESERVED for a possible future separate MAX key (+ its backup);
#               unused, in no ring.
# An UNSET .pub is an entry that verifies nothing (the build still works).
RELEASE_RING = {
    "0": "//firmware/ota:keys/release.pub",
    "1": "//firmware/ota:keys/backup.pub",
    "2": "//firmware/ota:keys/next.pub",
}

# The checked-in TEST keys (public knowledge: HITL / development only).
TEST_RING = {
    "0": "//firmware/ota:keys/test.pub",
    "1": "//firmware/ota:keys/test_backup.pub",
}

# The Splanc MAX updater's rings ARE the C6 rings (not copies).
MAX_RELEASE_RING = RELEASE_RING

MAX_TEST_RING = TEST_RING
