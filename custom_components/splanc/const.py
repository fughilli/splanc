"""Constants for the Splanc integration."""

DOMAIN = "splanc"

CONF_PIN = "cert_sha256"
CONF_MAC = "mac"

# Shown to the lamp in Hello.client (it appears in the lamp's logs).
CLIENT_NAME = "home-assistant"

# The integration version (manifest.json "version"), sent as Hello.app_version.
VERSION = "0.1.0"

# Keypoint recall morph time when the service call gives no transition (s).
DEFAULT_EFFECT_SECONDS = 0.5
