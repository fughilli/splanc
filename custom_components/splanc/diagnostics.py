"""Diagnostics download: the session and the lamp's last reported state."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from . import SplancConfigEntry


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: SplancConfigEntry
) -> dict[str, Any]:
    # Nothing secret here: the certificate fingerprint is public by design.
    return {"entry": dict(entry.data), "lamp": entry.runtime_data.diagnostics()}
