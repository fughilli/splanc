"""Gate: the mbedtls objects netstack_transport.cpp declares match the LINKED library.

The image links the from-source mbedtls (@embedded's mbedtls_src). Its struct layouts
depend on the mbedtls config, and a translation unit that includes <mbedtls/*.h> without
the library's MBEDTLS_CONFIG_FILE silently gets upstream's default config instead. That
happened to the transport: it saw a 344 B mbedtls_ssl_context while the library's is
552 B, so mbedtls_ssl_init overran g_ssl by 208 B into g_conf on every init / setup /
session reset (#444, found by #440; root cause #468). mbedtls_src now propagates its
config as a `define` to every consumer (patches/embedded-mbedtls-propagate-config.patch),
so the two agree by construction; this test proves it on the shipped ELF.

For each image it reads, from the ELF itself (no DWARF needed, so it works on -c opt):

  - the LIBRARY's sizeof of each type, from the constant length its own code clears an
    object with: mbedtls_ssl_init / mbedtls_ssl_config_init / mbedtls_x509_crt_init
    memset theirs (`li a2,<n>` before the call), mbedtls_pk_free zeroizes its
    (`li a1,<n>` before mbedtls_platform_zeroize);
  - the TRANSPORT's sizeof of each type, as the size of the global it declares with it
    (g_ssl, g_conf, g_srvcert, g_pk: the symbol table's object sizes);

and requires them to be EQUAL. Smaller would be the overrun; larger means the transport
compiled against a different config too, which is just as wrong (other fields would be
at other offsets), so equality is the invariant, not "fits"."""

import os
import re
import subprocess
import unittest

# (transport global, the type it holds, library function, register carrying the length)
OBJECTS = [
    ("g_ssl", "mbedtls_ssl_context", "mbedtls_ssl_init", "a2"),
    ("g_conf", "mbedtls_ssl_config", "mbedtls_ssl_config_init", "a2"),
    ("g_srvcert", "mbedtls_x509_crt", "mbedtls_x509_crt_init", "a2"),
    ("g_pk", "mbedtls_pk_context", "mbedtls_pk_free", "a1"),
]


def runfile(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    assert p and os.path.exists(p), rel
    return p


def clear_len(objdump, elf, fn, reg):
    """The constant length the library's `fn` clears its argument with: the last `li
    <reg>,<n>` before the first call (memset / mbedtls_platform_zeroize)."""
    out = subprocess.run(
        [objdump, "-d", "--disassemble=" + fn, elf], check=True, capture_output=True, text=True
    ).stdout
    n = None
    for line in out.splitlines():
        m = re.search(r"\bli\s+%s,(\d+)" % reg, line)
        if m:
            n = int(m.group(1))
        if re.search(r"\b(jal|jalr|j|tail|call)\b.*<(memset|mbedtls_platform_zeroize)>", line):
            break
    assert n, "no clear length (li %s) in %s:\n%s" % (reg, fn, out[-2000:])
    return n


def symbol_sizes(objdump, elf):
    """name -> size of every data object; names demangled, namespace stripped."""
    out = subprocess.run(
        [objdump, "-t", "-C", elf], check=True, capture_output=True, text=True
    ).stdout
    sizes = {}
    for line in out.splitlines():
        # 40831ff0 l     O .bss	00000228 (anonymous namespace)::g_ssl
        m = re.match(r"^[0-9a-f]+\s.*\sO\s+\S+\s+([0-9a-f]+)\s+(.*)$", line)
        if m:
            sizes.setdefault(m.group(2).split("::")[-1], []).append(int(m.group(1), 16))
    return sizes


class TlsAbiTest(unittest.TestCase):
    def check_image(self, env):
        objdump = runfile(os.environ["OBJDUMP"])
        elf = runfile(os.environ[env])
        sizes = symbol_sizes(objdump, elf)
        for sym, ty, fn, reg in OBJECTS:
            with self.subTest(image=env, type=ty):
                lib = clear_len(objdump, elf, fn, reg)
                self.assertIn(sym, sizes, "%s: the transport's %s global is gone" % (env, sym))
                self.assertEqual(
                    len(sizes[sym]), 1, "%s: several %s objects: %s" % (env, sym, sizes[sym])
                )
                self.assertEqual(
                    sizes[sym][0],
                    lib,
                    "%s: the transport's %s is %d B but the linked library's is %d B: a TU "
                    "that includes <mbedtls/*.h> is not compiled with the library's "
                    "MBEDTLS_CONFIG_FILE" % (env, ty, sizes[sym][0], lib),
                )

    def test_player(self):
        self.check_image("ELF")

    def test_loader(self):
        # The OTA loader links the same :netstack_transport.
        self.check_image("LOADER_ELF")


if __name__ == "__main__":
    unittest.main()
