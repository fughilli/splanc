"""PR-23 — HITL infrastructure validates representative operational flows (the
connectivity preflight). Simulation-level coverage of the harness's reachability
check that every WS flow runs before tunnelling to a just-provisioned DUT.

``Reservation.assert_reachable`` probes the DUT's TCP ports FROM the rig so an
unreachable / foreign-AP board fails fast with an actionable error instead of a
later vague "ws never came up", and — load-bearing for the FUG-89 device-vs-rig
accounting — it distinguishes a DEVICE/connectivity failure (the probe's own
"unreachable" verdict -> ``DutUnreachable``) from RIG trouble (ssh itself failing
or hanging -> ``ReserveError``). This is the connectivity half of the HITL infra
that validates provisioning/flashing/connectivity flows.

This file pins that a passing probe really checked the DUT host and port it will
tunnel to. The device-vs-rig classification itself (probe exit 7 ->
DutUnreachable; any other exit or an ssh hang -> ReserveError) is pinned once, in
test_e2e_phases.py::test_the_reachability_probe_tells_the_rig_from_the_dut.

Pure logic: ssh is stubbed, no network. See hitl_client.assert_reachable (commit
d037ccd6) and harness/e2e_phases.is_infrastructure (DutUnreachable is a device
failure; ReserveError is not).
"""

import pytest
from hitl_client import Reservation

pytestmark = pytest.mark.requirements("PR-23")


class _Proc:
    def __init__(self, returncode):
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


class _Res(Reservation):
    """A Reservation whose ssh() is a scripted stub: it records the probe command
    and returns a canned result (or raises) instead of touching a rig."""

    def __init__(self, result):
        super().__init__(server="http://hitl-rig-1:8087")
        self._result = result
        self.probes = []

    def ssh(self, remote_cmd, capture=False, timeout=None):
        self.probes.append(remote_cmd)
        if isinstance(self._result, BaseException):
            raise self._result
        return self._result


def test_reachable_dut_passes_and_actually_probes_the_target():
    r = _Res(_Proc(returncode=0))
    r.assert_reachable("10.42.0.9", ports=(443,))
    # Non-vacuous: it issued a probe that names the DUT host and the port it will
    # tunnel to (so a "pass" means it really checked the right target).
    assert r.probes and "10.42.0.9" in r.probes[0] and "443" in r.probes[0]
