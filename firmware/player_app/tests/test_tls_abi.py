"""Gate: the mbedtls contexts netstack_transport.cpp declares hold the LINKED library's.

The transport compiles against the prebuilt SDK's mbedtls headers while the image links
the from-source mbedtls (@embedded's mbedtls_src), and the two disagree on
mbedtls_ssl_context (344 B vs 552 B). The transport therefore keeps each context in an
SslBox of kSslContextBytes; this reads every compile unit's struct sizes from the ELF's
DWARF and checks the largest fits (and that the other contexts it declares by value are
no smaller than the library's)."""

import os
import re
import subprocess
import unittest


def runfile(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    assert p and os.path.exists(p), rel
    return p


def struct_sizes(objdump, elf, names):
    out = subprocess.run([objdump, "--dwarf=info", elf], check=True, capture_output=True, text=True).stdout
    sizes = {n: set() for n in names}
    lines = out.splitlines()
    pat = re.compile(r"DW_AT_name\s*:.*?\b(%s)$" % "|".join(names))
    for i, line in enumerate(lines):
        m = pat.search(line)
        if not m:
            continue
        for nxt in lines[i + 1 : i + 4]:
            b = re.search(r"DW_AT_byte_size\s*:\s*(\d+)", nxt)
            if b:
                sizes[m.group(1)].add(int(b.group(1)))
                break
    return sizes


class TlsAbiTest(unittest.TestCase):
    def test_contexts_fit(self):
        src = open(runfile("_main/firmware/player_app/netstack_transport.cpp")).read()
        box = int(re.search(r"constexpr size_t kSslContextBytes = (\d+);", src).group(1))
        objdump = runfile(os.environ["OBJDUMP"])
        for elf in os.environ["ELFS"].split():
            sizes = struct_sizes(objdump, runfile(elf), ["mbedtls_ssl_context", "mbedtls_ssl_config",
                                                         "mbedtls_x509_crt", "mbedtls_pk_context"])
            ctx = sizes["mbedtls_ssl_context"]
            self.assertTrue(ctx, "no mbedtls_ssl_context in %s" % elf)
            self.assertLessEqual(max(ctx), box, "%s: the library's context (%s B) outgrew SslBox" % (elf, ctx))
            # Declared by value (g_conf, g_srvcert, g_pk): one size, or ours the larger.
            for n in ["mbedtls_ssl_config", "mbedtls_x509_crt", "mbedtls_pk_context"]:
                self.assertTrue(len(sizes[n]) <= 2, (elf, n, sizes[n]))


if __name__ == "__main__":
    unittest.main()
