"""A tap on the lamp's lid (its toggle trigger fired) as an event entity, for
automations such as "a tap on the bedroom lamp also turns off the hall"."""

from __future__ import annotations

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SplancConfigEntry
from . import protocol as p
from .entity import SplancEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SplancConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    # Only lamps with the power feature report the toggle trigger.
    if entry.runtime_data.state.has_power:
        async_add_entities([SplancTouchEvent(entry)])


class SplancTouchEvent(SplancEntity, EventEntity):
    _attr_translation_key = "touch"
    _attr_event_types = ["tap"]

    def __init__(self, entry: SplancConfigEntry) -> None:
        super().__init__(entry, "touch")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.lamp.add_touch_listener(self._on_touch))

    @callback
    def _on_touch(self, event_type: str, ps: p.PowerState) -> None:
        self._trigger_event(event_type, {"on": ps.on, "trigger": ps.toggle_trigger or None})
        self.async_write_ha_state()
