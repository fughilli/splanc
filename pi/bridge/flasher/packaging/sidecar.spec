# PyInstaller spec: freeze the flasher sidecar into one self-contained program
# (no Python needed on the user's machine). Adapted from td-deploy Studio's
# app/packaging/sidecar.spec (MIT).
#
#   python -m PyInstaller --noconfirm --distpath pi/bridge/flasher/dist \
#       --workpath pi/bridge/flasher/.pyibuild pi/bridge/flasher/packaging/sidecar.spec
#
# Bundles the sidecar + splanc_flasher (stdlib only) and certifi's CA roots
# (the frozen interpreter has no OpenSSL trust store). zstd comes from Python
# 3.14's stdlib `compression.zstd` (CI builds with 3.14); `zstandard` is
# collected too when installed, as a fallback.
import os
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules

FLASHER = os.path.abspath(os.path.join(SPECPATH, ".."))  # noqa: F821 - PyInstaller global
sys.path.insert(0, FLASHER)

hidden = collect_submodules("splanc_flasher") + ["compression.zstd"]
datas, binaries = [], []
for mod in ("certifi", "zstandard"):
    try:
        d, b, h = collect_all(mod)
    except Exception:  # noqa: BLE001 - optional
        continue
    datas += d
    binaries += b
    hidden += h

version_json = os.path.join(FLASHER, "version.json")
if os.path.isfile(version_json):
    datas.append((version_json, "."))

a = Analysis(  # noqa: F821
    [os.path.join(FLASHER, "sidecar.py")],
    pathex=[FLASHER],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "pytest", "unittest", "pydoc"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="splanc-flasher-sidecar",
    console=True,  # stdio JSON protocol; Electron hides the window
)
coll = COLLECT(  # noqa: F821
    exe, a.binaries, a.datas, strip=False, upx=False, name="splanc-flasher-sidecar"
)
