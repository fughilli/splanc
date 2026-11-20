"""The Splanc integration: Splanc LED lamps as Home Assistant lights.

One config entry per lamp. The entry keeps one wss session to the lamp
(lamp.py), and the lamp pushes its power state over it, so nothing polls.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_create_clientsession

from .const import CLIENT_NAME, CONF_MAC, CONF_PIN, VERSION
from .lamp import CannotConnect, CertificateMismatch, LampError, SplancLamp

PLATFORMS = [Platform.LIGHT, Platform.EVENT]

# (Not a PEP 695 `type` alias: the repo's lint runs on Python 3.11.)
SplancConfigEntry = ConfigEntry[SplancLamp]


async def async_setup_entry(hass: HomeAssistant, entry: SplancConfigEntry) -> bool:
    # A session of our own: the lamp's TLS settings (no CA, pinned) must not leak
    # into Home Assistant's shared one.
    session = async_create_clientsession(hass, verify_ssl=False)
    lamp = SplancLamp(
        session,
        entry.data[CONF_HOST],
        entry.data[CONF_PIN],
        client=CLIENT_NAME,
        app_version=VERSION,
        mac=entry.data.get(CONF_MAC, ""),
    )

    @callback
    def _cert_changed(_err: CertificateMismatch) -> None:
        entry.async_start_reauth(hass)

    lamp.on_cert_mismatch = _cert_changed
    try:
        await lamp.start()
    except CertificateMismatch as err:
        await lamp.stop()
        raise ConfigEntryAuthFailed(str(err)) from err
    except (CannotConnect, LampError) as err:
        await lamp.stop()
        raise ConfigEntryNotReady(f"{entry.data[CONF_HOST]}: {err}") from err

    entry.runtime_data = lamp
    entry.async_on_unload(lamp.stop)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SplancConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
