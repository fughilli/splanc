"""Regression guards for hitl_improv's provisioning-flake fix (FUG-61 / FUG-94).

FUG-94 re-measured the flake on the rig: the BLE connect to a freshly-booted C6
fails ~50% PER ATTEMPT, and — crucially — the rate is independent of how long the
board has been advertising and of whether its name had resolved. So the
load-bearing half of the fix is the `_connect` RAPID-RETRY LOOP (rides out the
per-attempt failure within one boot), NOT the find() name-wait gate. Both are
guarded here so neither is "simplified" away:

  * test_connect_* — the retry loop must ride out transient per-attempt connect
    failures within one boot (the actual deflaker), and its default must stay >1.
  * test_*named* / test_*nameless* — find()'s name-wait gate is cheap
    defence-in-depth: it must never hand a name-LESS advertisement straight to the
    connect path (a name-less match means the scan response hasn't landed), and it
    costs nothing when the name is already present.

hitl_improv only runs in the rig container (it imports bleak), so we stub bleak
with a fake scanner/client and exercise the pure logic offline.
"""

import asyncio
import importlib
import inspect
import sys
import types


class _StubClient:
    """Fake BleakClient. Class-level `outcomes` is a list of bools consumed per
    connect() call: True => the link comes up, False => raise a transport error
    (the message-less connect TimeoutError the real flake produces)."""

    outcomes = []
    idx = 0
    last_adapter = "unset"  # records the adapter= kwarg of the most recent construction

    def __init__(self, *a, **k):
        self.is_connected = False
        _StubClient.last_adapter = k.get("adapter", None)

    async def connect(self):
        i = _StubClient.idx
        _StubClient.idx += 1
        ok = _StubClient.outcomes[i] if i < len(_StubClient.outcomes) else True
        if not ok:
            raise TimeoutError()  # empty message, exactly like bleak's connect timeout
        self.is_connected = True

    async def disconnect(self):
        self.is_connected = False


def _install_bleak_stub():
    bleak = types.ModuleType("bleak")
    bleak.BleakClient = _StubClient

    class BleakScanner:
        discover_results = []  # list of {addr: (dev, adv)} returned per call
        calls = 0
        rescan_dev = None  # what find_device_by_address returns (rescan handle)
        last_adapter = "unset"  # records the adapter= kwarg of the most recent call

        @staticmethod
        async def discover(timeout=0, return_adv=False, **kwargs):
            i = BleakScanner.calls
            BleakScanner.calls += 1
            BleakScanner.last_adapter = kwargs.get("adapter", None)
            res = BleakScanner.discover_results
            return res[min(i, len(res) - 1)] if res else {}

        @staticmethod
        async def find_device_by_address(addr, timeout=0, **kwargs):
            BleakScanner.last_adapter = kwargs.get("adapter", None)
            return BleakScanner.rescan_dev

    bleak.BleakScanner = BleakScanner
    exc = types.ModuleType("bleak.exc")

    class BleakError(Exception):
        pass

    exc.BleakError = BleakError
    bleak.exc = exc
    sys.modules["bleak"] = bleak
    sys.modules["bleak.exc"] = exc
    return BleakScanner


_SCANNER = _install_bleak_stub()
hitl_improv = importlib.import_module("hitl_improv")


class _Dev:
    def __init__(self, address, name):
        self.address = address
        self.name = name


class _Adv:
    def __init__(self, service_uuids):
        self.service_uuids = service_uuids


ADDR = "8c:fd:49:12:31:72"
SVC = hitl_improv.SVC


def _sighting(name):
    return {ADDR: (_Dev(ADDR, name), _Adv([SVC]))}


def _run(coro):
    _SCANNER.calls = 0
    return asyncio.get_event_loop().run_until_complete(coro)


async def _no_sleep(*_a, **_k):  # keep the retry backoff from making tests slow
    return None


# --- find() name-wait gate (defence-in-depth) --------------------------------


def test_prefers_named_sighting_and_returns_on_first_name():
    # Scan 1: name-less (scan response not in yet). Scan 2: name resolved.
    _SCANNER.discover_results = [_sighting(""), _sighting("Led Widget 9C9E07")]
    dev, nm = _run(hitl_improv.find(ADDR, "", scan_seconds=1.0, name_wait=8.0))
    assert nm == "Led Widget 9C9E07"
    assert dev is not None
    # It must have re-scanned past the name-less first sighting (the gate), i.e.
    # not pounced on the empty-name device.
    assert _SCANNER.calls >= 2


def test_never_returns_nameless_without_waiting_out_name_wait():
    # The board only ever advertises name-less within the window. find() may fall
    # back to the name-less hit, but ONLY after waiting out name_wait — it must
    # re-scan ceil(name_wait/scan_seconds) times, never return on the first scan.
    _SCANNER.discover_results = [_sighting("")]  # always name-less
    scan_seconds, name_wait = 1.0, 4.0
    dev, nm = _run(hitl_improv.find(ADDR, "", scan_seconds=scan_seconds, name_wait=name_wait))
    assert nm == ""  # fell back to the name-less hit (nothing better existed)
    assert dev is not None
    # The guard: it waited. With 1s scans and a 4s name_wait, that is >= 4 scans,
    # and unconditionally more than the single scan an "early pounce" would do.
    assert _SCANNER.calls >= int(name_wait / scan_seconds)
    assert _SCANNER.calls > 1


def test_returns_named_immediately_no_extra_scans():
    # A board already fully advertising (name resolved) is returned on scan 1 —
    # the gate costs nothing when the scan response is already present.
    _SCANNER.discover_results = [_sighting("Led Widget 9C9E07")]
    dev, nm = _run(hitl_improv.find(ADDR, "", scan_seconds=1.0, name_wait=8.0))
    assert nm == "Led Widget 9C9E07"
    assert _SCANNER.calls == 1


# --- _connect() retry loop (the load-bearing deflaker) -----------------------


def _reset_client(outcomes):
    _StubClient.outcomes = outcomes
    _StubClient.idx = 0
    _SCANNER.rescan_dev = _Dev(ADDR, "Led Widget 9C9E07")  # board still advertising on rescan


def test_connect_rides_out_transient_per_attempt_failures(monkeypatch):
    # The real flake: the first few connects to a freshly-booted C6 time out, then
    # one succeeds. A single try (the pre-FUG-61 behaviour) would have failed; the
    # retry loop must ride it out within one boot.
    monkeypatch.setattr(hitl_improv.asyncio, "sleep", _no_sleep)
    _reset_client([False, False, False, True])  # 3 timeouts, then success
    dev = _Dev(ADDR, "Led Widget 9C9E07")
    client = _run(hitl_improv._connect(dev, tries=5, connect_timeout=1.0))
    assert client.is_connected
    assert _StubClient.idx >= 4  # it retried past the failures (didn't pounce once)


def test_single_try_would_have_failed(monkeypatch):
    # Guards the premise: with tries=1 the same transient failure is fatal — which
    # is exactly why the loop (tries>1) is load-bearing, not the name gate.
    monkeypatch.setattr(hitl_improv.asyncio, "sleep", _no_sleep)
    _reset_client([False, True])
    dev = _Dev(ADDR, "Led Widget 9C9E07")
    try:
        _run(hitl_improv._connect(dev, tries=1, connect_timeout=1.0))
        raised = False
    except Exception:
        raised = True
    assert raised


def test_connect_gives_up_after_all_tries(monkeypatch):
    monkeypatch.setattr(hitl_improv.asyncio, "sleep", _no_sleep)
    _reset_client([False, False, False])  # never succeeds
    dev = _Dev(ADDR, "Led Widget 9C9E07")
    try:
        _run(hitl_improv._connect(dev, tries=3, connect_timeout=1.0))
        raised = False
    except Exception:
        raised = True
    assert raised


def test_provision_default_connect_tries_stays_above_one():
    # The load-bearing default: don't let anyone quietly revert connect_tries to 1.
    default = inspect.signature(hitl_improv.provision).parameters["connect_tries"].default
    assert default > 1


# --- HITL_BLE_ADAPTER threading (route BLE at the USB dongle, not onboard) ----


def test_ble_adapter_env_threads_into_scan_and_connect(monkeypatch):
    # On a dongle rig the daemon sets HITL_BLE_ADAPTER=hciN; every bleak entry point
    # (scan, rescan, connect) must pass adapter=hciN, else it hits the default hci0
    # (the flaky onboard controller). Guards all three call sites at once.
    monkeypatch.setenv("HITL_BLE_ADAPTER", "hci1")
    monkeypatch.setattr(hitl_improv.asyncio, "sleep", _no_sleep)
    # find() → discover() carries the adapter.
    _SCANNER.discover_results = [_sighting("Led Widget 9C9E07")]
    _run(hitl_improv.find(ADDR, "", scan_seconds=1.0, name_wait=8.0))
    assert _SCANNER.last_adapter == "hci1"
    # _connect() → BleakClient(adapter=…) and, on a forced rescan, find_by_address.
    _reset_client([True])
    dev = _Dev(ADDR, "Led Widget 9C9E07")
    _run(hitl_improv._connect(dev, tries=1, connect_timeout=1.0))
    assert _StubClient.last_adapter == "hci1"


def test_no_ble_adapter_env_uses_default(monkeypatch):
    # Unset → no adapter kwarg (None), i.e. bleak's system default. A plain rig must
    # not suddenly pin an adapter that may not exist.
    monkeypatch.delenv("HITL_BLE_ADAPTER", raising=False)
    _SCANNER.discover_results = [_sighting("Led Widget 9C9E07")]
    _run(hitl_improv.find(ADDR, "", scan_seconds=1.0, name_wait=8.0))
    assert _SCANNER.last_adapter is None
    _reset_client([True])
    dev = _Dev(ADDR, "Led Widget 9C9E07")
    _run(hitl_improv._connect(dev, tries=1, connect_timeout=1.0))
    assert _StubClient.last_adapter is None
