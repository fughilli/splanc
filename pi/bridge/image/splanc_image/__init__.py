"""On-device helpers of the Splanc bridge SD image (pi/bridge/image).

    bootconfig   apply the flash-time settings the Splanc Bridge Flasher wrote to
                 the card's FAT boot partition (WiFi, device name, country, ...)
    selfupdate   keep the Splanc agent bundle current from splanc.io/agent/latest.json

Both are stdlib-only and run on the image's Python (nix/packages.nix: pyEnv).
"""
