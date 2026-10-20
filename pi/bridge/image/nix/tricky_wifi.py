"""VM test fixture: a WiFi profile rendered by the flasher's own code for an SSID
and PSK full of keyfile-hostile characters, plus the values NetworkManager must
read back (nix/vm-test.nix compares them with `nmcli`).

    PYTHONPATH=<pi/bridge/flasher> python3 tricky_wifi.py <outdir>
"""

import json
import os
import sys

from splanc_flasher import bootfiles as bf

# Leading/trailing spaces, ';' (list separator), '\' (escape), '#' (comment),
# '=' and a non-ASCII letter (forces NetworkManager's byte-list SSID form).
SSID = " Café;Wi\\Fi #1 "
PSK = " p\\a;ss#wo=rd "

out = sys.argv[1]
with open(os.path.join(out, "splanc-wifi.nmconnection"), "w", encoding="utf-8") as f:
    f.write(bf.render_nmconnection(bf.Wifi(ssid=SSID, psk=PSK, hidden=True)))
with open(os.path.join(out, "expect.json"), "w", encoding="utf-8") as f:
    json.dump({"ssid": SSID, "psk": PSK}, f)
