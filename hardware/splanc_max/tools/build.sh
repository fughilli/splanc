#!/bin/sh
set -eu
# Manual component selection; no fabricated LCSC purchasing identifiers.
ato build hardware/splanc_max -b lv -b power -b usb_bridge \
  -t build-design -x default -x picker -v
