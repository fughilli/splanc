"""Make splanc_flasher (and, for the round-trip tests, the image's splanc_image)
importable when pytest runs straight from a checkout (packaging/build_app.*)."""

import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
for p in (os.path.join(_here, ".."), os.path.join(_here, "..", "..", "image")):
    p = os.path.abspath(p)
    if os.path.isdir(p) and p not in sys.path:
        sys.path.insert(0, p)
