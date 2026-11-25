"""The lamp as a light: on/off with the lamp's own transition, brightness, and
the effect's saved looks (keypoints) as the effect list."""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ATTR_TRANSITION,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SplancConfigEntry
from . import protocol as p
from .const import DEFAULT_EFFECT_SECONDS
from .entity import SplancEntity
from .lamp import LampError, TakenOver


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SplancConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([SplancLight(entry)])


class SplancLight(SplancEntity, LightEntity):
    _attr_name = None  # the device's name
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}

    def __init__(self, entry: SplancConfigEntry) -> None:
        super().__init__(entry, "light")

    @property
    def supported_features(self) -> LightEntityFeature:
        feats = LightEntityFeature.EFFECT
        if self.lamp.state.has_power:
            feats |= LightEntityFeature.TRANSITION
        return feats

    @property
    def is_on(self) -> bool | None:
        return self.lamp.state.is_on

    @property
    def brightness(self) -> int | None:
        b = self.lamp.state.brightness
        if b is None:
            return None
        # HA's 1..255 (0 means off); the lamp's 0..1.
        return (
            max(1, round(b * 255))
            if b > 0
            else (round(self.lamp.state.last_on_brightness * 255) or 1)
        )

    @property
    def effect_list(self) -> list[str] | None:
        return list(self.lamp.state.keypoints) or None

    @property
    def effect(self) -> str | None:
        return self.lamp.state.keypoint

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.lamp.state
        attrs: dict[str, Any] = {"effect_id": st.effect_id or None}
        if st.power is not None:
            ps = st.power
            attrs["phase"] = p.PHASE_NAMES[ps.phase] if ps.phase < len(p.PHASE_NAMES) else ps.phase
            attrs["last_change"] = (
                p.SOURCE_NAMES[ps.source] if ps.source < len(p.SOURCE_NAMES) else ps.source
            )
            if ps.toggle_trigger:
                attrs["toggle_trigger"] = ps.toggle_trigger
        return attrs

    async def _call(self, coro: Any) -> None:
        try:
            await coro
        except TakenOver as err:
            raise HomeAssistantError(
                "The Splanc app (or another client) is using the lamp right now; try again in a moment"
            ) from err
        except LampError as err:
            raise HomeAssistantError(f"{self.lamp.host}: {err}") from err

    async def async_turn_on(self, **kwargs: Any) -> None:
        transition = kwargs.get(ATTR_TRANSITION)
        if self.lamp.state.welcome is None:
            await self._call(self.lamp.connect())  # learn the features first
        if ATTR_BRIGHTNESS in kwargs:
            await self._call(self.lamp.set_brightness(kwargs[ATTR_BRIGHTNESS] / 255))
        if ATTR_EFFECT in kwargs:
            name = kwargs[ATTR_EFFECT]
            if name not in self.lamp.state.keypoints:
                raise HomeAssistantError(
                    f"the lamp's current effect has no saved look named {name!r}"
                )
            secs = float(transition) if transition is not None else DEFAULT_EFFECT_SECONDS
            await self._call(self.lamp.recall_keypoint(name, secs))
        if self.lamp.state.has_power:
            # PowerState.on is the TARGET: false while turning off, so this also
            # reverses a running off-transition.
            if not self.lamp.state.is_on:
                await self._call(self.lamp.set_power(True, duration_ms=_ms(transition)))
        elif ATTR_BRIGHTNESS not in kwargs and not self.lamp.state.is_on:
            # Older firmware: "on" = back to the last brightness.
            await self._call(self.lamp.set_power(True))

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._call(self.lamp.set_power(False, duration_ms=_ms(kwargs.get(ATTR_TRANSITION))))

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()


def _ms(transition: float | None) -> int:
    return 0 if transition is None else max(0, int(float(transition) * 1000))
