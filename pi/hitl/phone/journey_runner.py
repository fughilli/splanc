"""Run declarative JSON user journeys against the app-driver.

A journey is STRUCTURED DATA (inputs + ordered steps), not code — Maestro-style
(declarative flows + reusable subflows) but over our SEMANTIC app-driver protocol
(navigate / provisionBle / setHardwareConfig / query state / await milestone),
not DOM selectors. See pi/hitl/phone/journeys/*.json.

A step is one of:
  {"do": "<command>",  "with": {...}, "expect": {...}, "as": "name", "timeout": N}
  {"query": "<query>", "with": {...}, "expect": {...}, "as": "name"}
  {"await": "connected" | "milestone:<name>" | "state:<state>", "timeout": N, "match": {...}}
  {"runFlow": "<journey-name>"}                       # reusable subflow (inherits context)

`with`/`match` values interpolate ${var} from the merged inputs+context; a value that
is EXACTLY "${var}" keeps the variable's real type (int/list/None), so ${gpio} stays an int.

Expectations (per result field; dotted paths dig into nested dicts; "" or "$" = whole result):
  "present"          field exists and is non-null
  "nonempty"         list/str/dict is truthy
  {"equals": X}      deep equality
  {"contains": X}    substring / membership
  {"present": bool}  presence toggle
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

from driver_server import AppDriver, DriverError

_VAR = re.compile(r"\$\{([a-zA-Z0-9_]+)\}")

# Journey commands that, on a REAL-BLE target, must be driven by a real user gesture
# (adb taps + uiautomator) instead of the driver RPC — Chrome forbids
# navigator.bluetooth.requestDevice() and the cert-trust window.open() without one.
# Maps the journey command -> the PhoneTarget method that fulfils it.
_GESTURE_HANDLERS = {"provisionBle": "provision_ble", "trustCert": "trust_cert"}


async def _do(drv: AppDriver, target: Any, cmd: str, timeout: float, params: dict[str, Any]) -> Any:
    """Dispatch a `do` command: to the target's tap-driven handler when it's a
    gesture-gated command on a real-BLE target, else to the app-driver RPC. A
    `trustCert` on a lane that needs no real trust (virtual BLE / browser) is a no-op."""
    if target is not None and getattr(target, "ble_mode", "") == "real":
        meth = getattr(target, _GESTURE_HANDLERS.get(cmd, ""), None)
        if meth is not None:
            return await asyncio.to_thread(meth, **params)  # sync adb work off the loop
    if cmd == "trustCert":
        return {"skipped": True}  # browser uses --ignore-certificate-errors; mock BLE has no TLS
    return await drv.command(cmd, timeout=timeout, **params)


def _interp(obj: Any, ctx: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        m = _VAR.fullmatch(obj)
        if m:  # exactly "${var}" → preserve the value's type
            return ctx.get(m.group(1))
        return _VAR.sub(lambda mm: str(ctx.get(mm.group(1), "")), obj)
    if isinstance(obj, dict):
        return {k: _interp(v, ctx) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_interp(v, ctx) for v in obj]
    return obj


def _dig(result: Any, path: str) -> Any:
    if path in ("", "$"):
        return result
    cur = result
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _match_one(val: Any, cond: Any) -> bool:
    if cond == "present":
        return val is not None
    if cond == "nonempty":
        return bool(val)
    if isinstance(cond, dict):
        if "equals" in cond:
            return val == cond["equals"]
        if "contains" in cond:
            try:
                return cond["contains"] in val
            except TypeError:
                return False
        if "present" in cond:
            return (val is not None) == cond["present"]
    return val == cond


def _check(result: Any, expect: dict[str, Any] | None) -> None:
    for path, cond in (expect or {}).items():
        val = _dig(result, path)
        if not _match_one(val, cond):
            raise DriverError(f"expectation failed: {path!r} {cond!r} (got {val!r})")


async def _await(drv: AppDriver, spec: str, timeout: float, match: dict[str, Any]) -> Any:
    if spec == "connected":
        return await drv.wait_connected(timeout=timeout)
    if spec.startswith("milestone:"):
        return await drv.wait_event("milestone", timeout=timeout, name=spec.split(":", 1)[1])
    if spec.startswith("state:"):
        want = spec.split(":", 1)[1]
        loop_deadline = timeout
        while loop_deadline > 0:
            ev = await drv.wait_event("state", timeout=loop_deadline)
            if (ev.get("status") or {}).get("state") == want:
                return ev
        raise DriverError(f"state never reached {want}")
    raise DriverError(f"unknown await spec: {spec!r}")


async def run_journey(
    drv: AppDriver,
    journey: dict[str, Any],
    registry: dict[str, dict[str, Any]],
    context: dict[str, Any] | None = None,
    target: Any = None,
) -> list[dict[str, Any]]:
    """Execute one journey; raise DriverError on any expectation failure. `target` (a
    PhoneTarget) lets gesture-gated commands (provisionBle/trustCert) be driven via
    real taps on a real-BLE device instead of the driver RPC."""
    ctx: dict[str, Any] = dict(journey.get("inputs") or {})
    ctx.update(context or {})
    out: list[dict[str, Any]] = []
    for i, step in enumerate(journey.get("steps") or []):
        if "runFlow" in step:
            sub = registry.get(step["runFlow"])
            if sub is None:
                raise DriverError(f"runFlow: no journey {step['runFlow']!r}")
            out.extend(await run_journey(drv, sub, registry, ctx, target))
            continue
        if "do" in step:
            params = _interp(step.get("with") or {}, ctx)
            res = await _do(drv, target, step["do"], step.get("timeout", 60.0), params)
            _check(res, step.get("expect"))
        elif "query" in step:
            params = _interp(step.get("with") or {}, ctx)
            res = await drv.query(step["query"], **params)
            _check(res, step.get("expect"))
        elif "await" in step:
            res = await _await(
                drv,
                str(step["await"]),
                step.get("timeout", 60.0),
                _interp(step.get("match") or {}, ctx),
            )
        else:
            raise DriverError(f"step {i} has no do/query/await/runFlow: {step}")
        if step.get("as"):
            ctx[str(step["as"])] = res
        out.append(
            {
                "step": step.get("description")
                or step.get("do")
                or step.get("query")
                or step.get("await"),
                "result": res,
            }
        )
    return out


def load_journeys(dir_path: str) -> dict[str, dict[str, Any]]:
    """Load all *.json journeys in `dir_path`, keyed by their "name"."""
    registry: dict[str, dict[str, Any]] = {}
    for fn in sorted(os.listdir(dir_path)):
        if fn.endswith(".json"):
            with open(os.path.join(dir_path, fn), encoding="utf-8") as f:
                j = json.load(f)
            registry[j["name"]] = j
    return registry
