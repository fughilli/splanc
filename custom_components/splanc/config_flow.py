"""Config flow for Splanc: add a lamp found on the network, or by its address.

The lamp's certificate is self-signed, one per lamp. The flow pins the one it
sees on the first connect (trust on first use, like the Splanc app and agent).
If the lamp later presents another one (a factory reset, or something else
answering at its address), the entry asks for re-authentication: the user
confirms the new fingerprint, Home Assistant never re-trusts silently.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .const import CLIENT_NAME, CONF_MAC, CONF_PIN, DOMAIN, VERSION
from .lamp import CannotConnect, LampError, LampInfo, TakenOver, normalize_mac, probe

_LOGGER = logging.getLogger(__name__)


def _fmt_fp(fp: str) -> str:
    """'ab12cd…' -> 'AB:12:CD:…' (first 8 bytes) for a human to compare."""
    pairs = [fp[i : i + 2].upper() for i in range(0, min(len(fp), 16), 2)]
    return ":".join(pairs) + ("…" if len(fp) > 16 else "")


def _host_of(host: str, port: int | None) -> str:
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"  # IPv6 literal
    return host if port in (None, 443) else f"{host}:{port}"


class SplancConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._host: str | None = None
        self._info: LampInfo | None = None
        self._name: str | None = None

    async def _probe(self, host: str, pin: str | None = None) -> LampInfo:
        # A short-lived session of its own: a reauth flow can start while the
        # entry's setup is failing, and sessions made in that context are closed
        # with the entry.
        async with aiohttp.ClientSession() as session:
            return await probe(session, host, client=CLIENT_NAME, app_version=VERSION, pin=pin)

    async def _try_probe(self, host: str) -> tuple[LampInfo | None, str | None]:
        try:
            return await self._probe(host), None
        except TakenOver:
            return None, "busy"
        except CannotConnect as err:
            _LOGGER.debug("probe %s failed: %s", host, err)
            return None, "cannot_connect"
        except LampError:
            return None, "cannot_connect"

    def _entry_data(self, info: LampInfo, host: str) -> dict[str, Any]:
        return {CONF_HOST: host, CONF_PIN: info.fingerprint, CONF_MAC: info.mac}

    # -- by address -------------------------------------------------------------

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            info, err = await self._try_probe(host)
            if info is not None:
                await self.async_set_unique_id(info.mac)
                self._abort_if_unique_id_configured(updates={CONF_HOST: host})
                return self.async_create_entry(title=info.name, data=self._entry_data(info, host))
            errors["base"] = err or "cannot_connect"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required(CONF_HOST, default=(user_input or {}).get(CONF_HOST, "")): str}
            ),
            errors=errors,
        )

    # -- discovered -------------------------------------------------------------

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        props = discovery_info.properties
        mac = props.get("id", "")
        if not mac:
            return self.async_abort(reason="not_splanc")
        host = _host_of(str(discovery_info.ip_address), discovery_info.port)
        await self.async_set_unique_id(normalize_mac(mac))
        # A known lamp that moved to another address: follow it, no prompt.
        self._abort_if_unique_id_configured(updates={CONF_HOST: host})
        self._host = host
        self._name = props.get("name") or discovery_info.name.split(".")[0]
        self.context["title_placeholders"] = {"name": self._name}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        assert self._host is not None
        errors: dict[str, str] = {}
        if user_input is not None:
            info, err = await self._try_probe(self._host)
            if info is not None:
                if info.mac != self.unique_id:
                    return self.async_abort(reason="wrong_lamp")
                return self.async_create_entry(
                    title=info.name, data=self._entry_data(info, self._host)
                )
            errors["base"] = err or "cannot_connect"
        return self.async_show_form(
            step_id="zeroconf_confirm",
            description_placeholders={"name": self._name or "", "host": self._host},
            errors=errors,
        )

    # -- the lamp's certificate changed -----------------------------------------

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        self._host = entry_data[CONF_HOST]
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        assert self._host is not None
        errors: dict[str, str] = {}
        if user_input is None or self._info is None:
            info, err = await self._try_probe(self._host)
            if info is None:
                errors["base"] = err or "cannot_connect"
            elif info.mac != entry.unique_id:
                return self.async_abort(reason="wrong_lamp")
            else:
                self._info = info
        elif user_input is not None:
            return self.async_update_reload_and_abort(
                entry, data_updates={CONF_PIN: self._info.fingerprint, CONF_HOST: self._host}
            )
        return self.async_show_form(
            step_id="reauth_confirm",
            description_placeholders={
                "name": entry.title,
                "host": self._host,
                "old": _fmt_fp(entry.data.get(CONF_PIN, "")),
                "new": _fmt_fp(self._info.fingerprint) if self._info else "?",
            },
            errors=errors,
        )
