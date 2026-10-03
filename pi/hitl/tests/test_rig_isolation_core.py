"""Unit tests for the on-hardware rig-isolation probe's pure verdict
(rig_isolation_core). The hardware wrapper (harness/hitl_rig_isolation.py) reserves
a rig, fetches /status, and runs this verdict; here we cover the verdict off
hardware so its logic is proven regardless of the bench.

The property under test: the daemon's advertised USB DUT names are serial-derived
and no two collide (by serial or by a repeated name). These are untraced tooling
tests of the probe itself, not PR-30 evidence: no catalog, daemon or harness
isolation code runs here.
"""

import pytest
from rig_isolation_core import board_identities, check_distinct_board_identities


def test_serial_derived_names_yield_distinct_identities():
    units = [
        {"name": "c6-071234", "type": "esp32c6"},
        {"name": "c6-58e6c5", "type": "esp32c6"},
        {"name": "c3-ab12ef", "type": "esp32c3"},
    ]
    ids = check_distinct_board_identities(units)
    assert ids == {"c6-071234": "071234", "c6-58e6c5": "58e6c5", "c3-ab12ef": "ab12ef"}


def test_two_units_sharing_a_serial_identity_are_rejected():
    # Two distinct unit names that resolve to the SAME board serial — the daemon
    # cannot tell these DUTs apart by physical identity.
    units = [
        {"name": "c6-071234", "type": "esp32c6"},
        {"name": "c3-071234", "type": "esp32c3"},  # same serial -> ambiguous identity
    ]
    with pytest.raises(AssertionError) as e:
        check_distinct_board_identities(units)
    assert "share board identity" in str(e.value)


def test_one_unit_name_listed_twice_is_rejected():
    # The realistic collision: names are derived from the serial, so the same board
    # surfacing twice shows up as a repeated NAME — which a {name -> serial} map
    # would silently merge into one entry.
    units = [{"name": "c6-abc123", "type": "esp32c6"}, {"name": "c6-abc123", "type": "esp32c6"}]
    with pytest.raises(AssertionError) as e:
        check_distinct_board_identities(units)
    assert "listed more than once" in str(e.value)


def test_board_identity_matching_is_case_insensitive():
    # The daemon may surface the serial in either case; the identity must be the
    # same board either way, so a case-only difference is still a collision.
    units = [{"name": "c6-ABCDEF", "type": "esp32c6"}, {"name": "c6-abcdef", "type": "esp32c6"}]
    with pytest.raises(AssertionError):
        check_distinct_board_identities(units)


def test_boot_order_slot_names_are_not_treated_as_board_identities():
    # Names that are NOT serial-derived (a boot-order slot, a composite bench) yield
    # no identities -> the probe SKIPs rather than inventing a pass. A regression that
    # renamed discovered boards to boot-order slots would surface as "nothing to
    # evaluate", which the wrapper reports as skipped (not a false PR-30 pass).
    units = [{"name": "dut0", "type": "esp32c6"}, {"name": "c6-sdr", "type": "esp32c6+hackrf"}]
    assert board_identities(units) == {}
    assert check_distinct_board_identities(units) == {}
