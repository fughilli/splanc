"""Shared base for Splanc entities: device info, availability, push updates."""

from __future__ import annotations

from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC, DeviceInfo, format_mac
from homeassistant.helpers.entity import Entity

from .const import CONF_MAC, DOMAIN
from .lamp import SplancLamp


class SplancEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False  # the lamp pushes power_state

    def __init__(self, entry, key: str) -> None:
        self.lamp: SplancLamp = entry.runtime_data
        mac = entry.data.get(CONF_MAC) or entry.unique_id or entry.entry_id
        self._attr_unique_id = f"{mac}-{key}"
        w = self.lamp.state.welcome
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, mac)},
            connections={(CONNECTION_NETWORK_MAC, format_mac(mac))},
            manufacturer="Splanc",
            model="Splanc lamp",
            name=(w.device_name if w and w.device_name else entry.title),
            sw_version=(w.fw_version or None) if w else None,
            configuration_url=f"https://{self.lamp.host}/",
        )

    @property
    def available(self) -> bool:
        # Released (the app took the session) is still available: a command
        # reconnects on demand. Only a changed certificate makes it unavailable.
        return self.lamp.cert_mismatch is None and self.lamp.state.welcome is not None

    @property
    def assumed_state(self) -> bool:
        return self.lamp.state.assumed

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.lamp.add_listener(self._handle_update))

    def _handle_update(self) -> None:
        self.async_write_ha_state()
