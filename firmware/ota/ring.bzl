"""Keyring header command (gen_key_header.py --key ID=path ...)."""

def ring_cmd(ring):
    """The genrule cmd that writes the ring header for `ring` ({id: .pub path}) to $@."""
    return "$(execpath :gen_key_header) " + " ".join([
        "--key %s=$(location %s)" % (kid, ring[kid])
        for kid in sorted(ring.keys())
    ]) + " --out $@"
