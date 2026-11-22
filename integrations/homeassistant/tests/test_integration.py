"""End-to-end tests: Home Assistant + the Splanc integration + a fake lamp over
real wss on localhost."""

from __future__ import annotations

import asyncio
from ipaddress import ip_address
from unittest.mock import patch

import pytest
from fake_lamp import FakeLamp
from homeassistant import config_entries
from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ATTR_EFFECT_LIST,
    ATTR_TRANSITION,
)
from homeassistant.const import ATTR_ENTITY_ID, CONF_HOST, STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.splanc import lamp as lamp_mod
from custom_components.splanc import protocol as p
from custom_components.splanc.const import CONF_MAC, CONF_PIN, DOMAIN
from custom_components.splanc.diagnostics import async_get_config_entry_diagnostics

LIGHT = "light.coil"
EVENT = "event.coil_lid_tap"


async def _wait(cond, timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not cond():
            await asyncio.sleep(0.02)


async def _setup(hass: HomeAssistant, fake: FakeLamp) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=fake.mac,
        title=fake.name,
        data={CONF_HOST: fake.host, CONF_PIN: fake.fingerprint, CONF_MAC: fake.mac},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


# -- config flow ---------------------------------------------------------------


async def test_user_flow_pins_certificate(hass: HomeAssistant, lamp: FakeLamp) -> None:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_HOST: lamp.host}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Coil"
    assert result["data"] == {CONF_HOST: lamp.host, CONF_PIN: lamp.fingerprint, CONF_MAC: lamp.mac}
    assert result["result"].unique_id == lamp.mac


async def test_user_flow_cannot_connect(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_HOST: "127.0.0.1:1"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


def _zc(fake: FakeLamp, mac: str | None = None) -> ZeroconfServiceInfo:
    return ZeroconfServiceInfo(
        ip_address=ip_address("127.0.0.1"),
        ip_addresses=[ip_address("127.0.0.1")],
        hostname="splanc-001122.local.",
        name="Coil._splanc._tcp.local.",
        port=fake.port,
        type="_splanc._tcp.local.",
        properties={
            "id": mac or fake.mac,
            "name": fake.name,
            "fw": "1.20.0",
            "path": "/.well-known/splanc.json",
        },
    )


async def test_zeroconf_flow(hass: HomeAssistant, lamp: FakeLamp) -> None:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=_zc(lamp)
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "zeroconf_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_PIN] == lamp.fingerprint
    assert result["data"][CONF_HOST] == lamp.host


async def test_zeroconf_follows_a_known_lamp_to_its_new_address(
    hass: HomeAssistant, lamp: FakeLamp
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=lamp.mac,
        data={CONF_HOST: "10.0.0.9", CONF_PIN: lamp.fingerprint, CONF_MAC: lamp.mac},
    )
    entry.add_to_hass(hass)
    with patch("custom_components.splanc.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_ZEROCONF},
            data=_zc(lamp, "aa-bb-cc-00-11-22"),
        )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data[CONF_HOST] == lamp.host


# -- the light -----------------------------------------------------------------


async def test_state_comes_from_get_power(hass: HomeAssistant, lamp: FakeLamp) -> None:
    await _setup(hass, lamp)
    st = hass.states.get(LIGHT)
    assert st.state == STATE_ON
    assert st.attributes[ATTR_BRIGHTNESS] == round(0.8 * 255)
    assert st.attributes[ATTR_EFFECT_LIST] == ["Calm", "Party"]
    # Subscribed: get_power right after hello.
    arms = [a for a, _ in lamp.log]
    assert arms[:2] == [p.C_HELLO, p.C_GET_POWER]
    # A polite background client: nothing but what it needed.
    assert p.C_TIME_SYNC_PING not in arms


async def test_turn_off_and_on_with_transition(hass: HomeAssistant, lamp: FakeLamp) -> None:
    await _setup(hass, lamp)
    await hass.services.async_call(
        "light", "turn_off", {ATTR_ENTITY_ID: LIGHT, ATTR_TRANSITION: 2}, blocking=True
    )
    assert lamp.on is False
    sp = lamp.sent(p.C_SET_POWER)[-1]
    assert sp.get(4) == [2000]
    assert hass.states.get(LIGHT).state == STATE_OFF

    await hass.services.async_call(
        "light", "turn_on", {ATTR_ENTITY_ID: LIGHT, ATTR_BRIGHTNESS: 51}, blocking=True
    )
    assert lamp.on is True
    assert lamp.brightness == pytest.approx(0.2)
    st = hass.states.get(LIGHT)
    assert st.state == STATE_ON
    assert st.attributes[ATTR_BRIGHTNESS] == 51


async def test_effect_recalls_a_keypoint(hass: HomeAssistant, lamp: FakeLamp) -> None:
    await _setup(hass, lamp)
    await hass.services.async_call(
        "light", "turn_on", {ATTR_ENTITY_ID: LIGHT, ATTR_EFFECT: "Party"}, blocking=True
    )
    bk = lamp.sent(p.C_BLEND_KEYPOINTS)[-1]
    weights = p.fields(bk[2][0])
    assert weights[0][2] == b"Party"
    assert p.unpack_float(bk[3][0]) == pytest.approx(0.5)
    assert hass.states.get(LIGHT).attributes[ATTR_EFFECT] == "Party"
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            "light", "turn_on", {ATTR_ENTITY_ID: LIGHT, ATTR_EFFECT: "Nope"}, blocking=True
        )


async def test_lid_tap_is_pushed_not_polled(hass: HomeAssistant, lamp: FakeLamp) -> None:
    await _setup(hass, lamp)
    before = len(lamp.log)
    await lamp.tap()
    await _wait(lambda: hass.states.get(LIGHT).state == STATE_OFF)
    st = hass.states.get(LIGHT)
    assert st.attributes["last_change"] == "trigger"
    ev = hass.states.get(EVENT)
    assert ev is not None and ev.attributes["event_type"] == "tap"
    # The update came by push: HA sent nothing.
    assert len(lamp.log) == before


async def test_new_effect_refreshes_the_effect_list(hass: HomeAssistant, lamp: FakeLamp) -> None:
    await _setup(hass, lamp)
    await lamp.change_effect("embers", ["Low", "High", "Max"])
    await _wait(
        lambda: hass.states.get(LIGHT).attributes.get(ATTR_EFFECT_LIST) == ["Low", "High", "Max"]
    )


async def test_stale_push_is_dropped(hass: HomeAssistant, lamp: FakeLamp) -> None:
    entry = await _setup(hass, lamp)
    sl = entry.runtime_data
    lamp.seq = 7
    newer = lamp.power_state()
    assert sl._apply_power(newer) is True
    older = p.PowerState(
        on=not newer.on, seq=6, brightness=newer.brightness, effect_id=newer.effect_id
    )
    assert sl._apply_power(older) is False
    assert sl.state.power.on == newer.on


# -- one session at a time (the phone app wins) --------------------------------


async def test_takeover_releases_then_command_reconnects(
    hass: HomeAssistant, lamp: FakeLamp
) -> None:
    entry = await _setup(hass, lamp)
    sl = entry.runtime_data
    phone = await lamp.phone_connects()
    await _wait(lambda: not sl.connected)
    st = hass.states.get(LIGHT)
    assert st.state != STATE_UNAVAILABLE
    assert st.attributes.get("assumed_state") is True
    assert sl.state.takeovers == 1
    # No immediate fight-back: the background retry waits >= ~60 s.
    connects = lamp.connects
    await asyncio.sleep(0.5)
    assert lamp.connects == connects

    # The phone app goes idle: a command from HA takes over and is carried out.
    await hass.services.async_call("light", "turn_off", {ATTR_ENTITY_ID: LIGHT}, blocking=True)
    assert lamp.on is False
    assert sl.connected
    # Resync on every reconnect: hello, get_power, list_keypoints, then the command.
    tail = [a for a, _ in lamp.log][-4:]
    assert tail == [p.C_HELLO, p.C_GET_POWER, p.C_LIST_KEYPOINTS, p.C_SET_POWER]
    assert hass.states.get(LIGHT).attributes.get("assumed_state") is not True
    phone.cancel()


async def test_command_while_the_phone_is_busy_fails_cleanly(
    hass: HomeAssistant, lamp: FakeLamp
) -> None:
    entry = await _setup(hass, lamp)
    sl = entry.runtime_data
    phone = await lamp.phone_connects(busy=True)
    await _wait(lambda: not sl.connected)
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("light", "turn_off", {ATTR_ENTITY_ID: LIGHT}, blocking=True)
    assert lamp.refused == 1
    assert lamp.on is True
    phone.cancel()


async def test_takeover_backoff_schedule() -> None:
    """60 s, doubling to 10 min after repeated failures, with +-20 % jitter."""
    seen: list[float] = []

    class StopLoop(Exception):
        pass

    sl = lamp_mod.SplancLamp(None, "127.0.0.1:1", "00", rand=lambda: 0.5)  # type: ignore[arg-type]
    sl.state.taken_over_at = 1.0

    async def fake_connect() -> None:
        raise lamp_mod.CannotConnect("refused")

    real_timeout = asyncio.timeout

    def fake_timeout(delay):
        seen.append(delay)
        if len(seen) > 6:
            raise StopLoop
        return real_timeout(0)

    sl.connect = fake_connect  # type: ignore[method-assign]
    with patch.object(lamp_mod.asyncio, "timeout", fake_timeout):
        with pytest.raises(StopLoop):
            await sl._run()
    assert seen[:6] == [60.0, 120.0, 240.0, 480.0, 600.0, 600.0]


async def test_ordinary_drop_retries_fast() -> None:
    seen: list[float] = []

    class StopLoop(Exception):
        pass

    sl = lamp_mod.SplancLamp(None, "127.0.0.1:1", "00", rand=lambda: 0.5)  # type: ignore[arg-type]

    async def fake_connect() -> None:
        raise lamp_mod.CannotConnect("down")

    real_timeout = asyncio.timeout

    def fake_timeout(delay):
        seen.append(delay)
        if len(seen) > 8:
            raise StopLoop
        return real_timeout(0)

    sl.connect = fake_connect  # type: ignore[method-assign]
    with patch.object(lamp_mod.asyncio, "timeout", fake_timeout):
        with pytest.raises(StopLoop):
            await sl._run()
    assert seen[:8] == [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0]


# -- the certificate -----------------------------------------------------------


async def test_new_certificate_asks_the_user(hass: HomeAssistant, lamp: FakeLamp) -> None:
    entry = await _setup(hass, lamp)
    old = lamp.fingerprint
    await lamp.restart_with_new_cert()
    assert lamp.fingerprint != old
    # The next command reconnects, sees the new certificate, and refuses.
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call("light", "turn_off", {ATTR_ENTITY_ID: LIGHT}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(LIGHT).state == STATE_UNAVAILABLE
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == ["reauth"]
    result = await hass.config_entries.flow.async_configure(flows[0]["flow_id"], {})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_PIN] == lamp.fingerprint
    await hass.async_block_till_done()
    await _wait(lambda: hass.states.get(LIGHT).state != STATE_UNAVAILABLE)


async def test_setup_with_a_changed_certificate_needs_reauth(
    hass: HomeAssistant, lamp: FakeLamp
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=lamp.mac,
        data={CONF_HOST: lamp.host, CONF_PIN: "ab" * 32, CONF_MAC: lamp.mac},
    )
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is config_entries.ConfigEntryState.SETUP_ERROR
    assert [
        f["context"]["source"] for f in hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    ] == ["reauth"]


# -- older firmware ------------------------------------------------------------


async def test_without_power_feature_on_off_is_brightness(
    hass: HomeAssistant, old_lamp: FakeLamp
) -> None:
    entry = await _setup(hass, old_lamp)
    assert hass.states.get(LIGHT).state == STATE_ON
    assert hass.states.get(EVENT) is None
    await hass.services.async_call("light", "turn_off", {ATTR_ENTITY_ID: LIGHT}, blocking=True)
    assert old_lamp.brightness == 0.0
    assert hass.states.get(LIGHT).state == STATE_OFF
    await hass.services.async_call("light", "turn_on", {ATTR_ENTITY_ID: LIGHT}, blocking=True)
    assert old_lamp.brightness == pytest.approx(0.8)
    assert not old_lamp.sent(p.C_SET_POWER)
    diag = await async_get_config_entry_diagnostics(hass, entry)
    assert diag["lamp"]["power_supported"] is False
    assert diag["lamp"]["on_off_mode"].startswith("brightness")


async def test_unload(hass: HomeAssistant, lamp: FakeLamp) -> None:
    entry = await _setup(hass, lamp)
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    await _wait(lambda: lamp.session is None)
