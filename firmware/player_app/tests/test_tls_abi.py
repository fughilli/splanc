"""Gate: the mbedtls context netstack_transport.cpp declares holds the LINKED library's.

The transport compiles against the prebuilt SDK's mbedtls headers while the image links
the from-source mbedtls (@embedded's mbedtls_src), and the two disagree on
mbedtls_ssl_context (344 B vs 552 B). A plain `mbedtls_ssl_context g_ssl;` was therefore
overrun by 208 B into the next global (g_conf) on every init/setup/reset (#444, found by
#440). The transport keeps the context in an SslBox of kSslContextBytes; this reads, from
the shipped ELF itself (no DWARF needed, so it works on the -c opt build):

  - the library's sizeof(mbedtls_ssl_context): the length mbedtls_ssl_init memsets
    (`li a2,<n>` before the memset call), and likewise mbedtls_ssl_config_init's;
  - the storage the transport actually reserves: the symbol sizes of g_ssl_box / g_conf;

and checks the library's context fits the box and its config fits g_conf."""

import os
import re
import subprocess
import unittest


def runfile(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    assert p and os.path.exists(p), rel
    return p


def memset_len(objdump, elf, fn):
    """The constant length the library's `fn` memsets its argument with."""
    out = subprocess.run(
        [objdump, "-d", "--disassemble=" + fn, elf], check=True, capture_output=True, text=True
    ).stdout
    m = re.search(r"\bli\s+a2,(\d+)", out)
    assert m, "no memset length in %s:\n%s" % (fn, out[-2000:])
    return int(m.group(1))


def symbol_sizes(objdump, elf):
    out = subprocess.run(
        [objdump, "-t", "-C", elf], check=True, capture_output=True, text=True
    ).stdout
    sizes = {}
    for line in out.splitlines():
        # 40831ff0 l     O .bss	00000240 (anonymous namespace)::g_ssl_box
        m = re.match(r"^[0-9a-f]+\s.*\sO\s+\S+\s+([0-9a-f]+)\s+(.*)$", line)
        if m:
            sizes[m.group(2).split("::")[-1]] = int(m.group(1), 16)
    return sizes


class TlsAbiTest(unittest.TestCase):
    def test_context_fits_the_box(self):
        src = open(runfile("_main/firmware/player_app/netstack_transport.cpp")).read()
        box = int(re.search(r"constexpr size_t kSslContextBytes = (\d+);", src).group(1))
        objdump = runfile(os.environ["OBJDUMP"])
        elf = runfile(os.environ["ELF"])
        lib_ctx = memset_len(objdump, elf, "mbedtls_ssl_init")
        lib_conf = memset_len(objdump, elf, "mbedtls_ssl_config_init")
        sizes = symbol_sizes(objdump, elf)
        self.assertIn("g_ssl_box", sizes, "the transport's context storage is not SslBox")
        self.assertLessEqual(
            lib_ctx, box, "the library's context (%d B) outgrew SslBox (%d B)" % (lib_ctx, box)
        )
        self.assertGreaterEqual(
            sizes["g_ssl_box"], lib_ctx, "g_ssl_box is smaller than the library's context"
        )
        self.assertGreaterEqual(
            sizes["g_conf"],
            lib_conf,
            "g_conf (%d B) is smaller than the library's config (%d B)"
            % (sizes["g_conf"], lib_conf),
        )


if __name__ == "__main__":
    unittest.main()
