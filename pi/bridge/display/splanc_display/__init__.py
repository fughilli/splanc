"""splanc_display: the Splanc bridge appliance's status screens.

Reads the bridge's status file (``/run/splanc-bridge/status.json``) and draws it
on an HDMI framebuffer and on a Waveshare 1.3" OLED HAT, whose buttons drive the
bridge's control socket. See pi/bridge/README.md.
"""

__version__ = "1.0.0"
