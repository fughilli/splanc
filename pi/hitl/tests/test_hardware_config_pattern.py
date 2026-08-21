"""Unit tests for the hardware-config color-order helpers (pure; wire parity).

These pin what the logic analyzer should decode for each configured wire color
order (hardware_config_pattern) against first principles, with no hardware, so the
drive/decode contract of the on-hardware test (//pi/hitl/harness:hardware_config)
can't silently drift."""

from hardware_config_pattern import (
    COLOR_ORDERS,
    expected_decoded_pixels,
    la_decoded,
    perm,
)

RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


def test_perm_known_orders():
    assert perm("RGB") == (0, 1, 2)
    assert perm("GRB") == (1, 0, 2)  # WS2812B default
    assert perm("BGR") == (2, 1, 0)
    assert perm("RBG") == (0, 2, 1)


def test_perm_rejects_non_permutation():
    for bad in ("RGX", "RG", "RRB", ""):
        try:
            perm(bad)
        except ValueError:
            continue
        raise AssertionError(f"perm({bad!r}) should have raised")


def test_grb_decodes_to_identity():
    # The default order: the analyzer reads back exactly the logical primaries
    # (this is what the sibling led_capture test observes on real hardware).
    for logical in (RED, GREEN, BLUE):
        assert la_decoded("GRB", logical) == logical


def test_rgb_order_swaps_red_and_green_on_the_wire():
    # Firmware RGB means the wire carries R,G,B; the analyzer (fixed GRB) reads
    # byte0 as green and byte1 as red, so logical red reads back green and vice
    # versa; blue (byte2) is unmoved.
    assert la_decoded("RGB", RED) == GREEN
    assert la_decoded("RGB", GREEN) == RED
    assert la_decoded("RGB", BLUE) == BLUE


def test_every_order_is_a_permutation_of_the_primaries():
    # Whatever the order, the three logical primaries must decode to three DISTINCT
    # primaries (a relabeling never merges or drops a channel).
    for order in COLOR_ORDERS:
        decoded = {la_decoded(order, p) for p in (RED, GREEN, BLUE)}
        assert decoded == {RED, GREEN, BLUE}, (order, decoded)


def test_expected_decoded_pixels_paints_through_the_order():
    # Three primary blocks under RGB: red->green, green->red, blue->blue.
    blocks = [(0, 1, RED), (1, 1, GREEN), (2, 1, BLUE)]
    assert expected_decoded_pixels("RGB", blocks, 3) == [GREEN, RED, BLUE]
    # Under the default GRB order it's the identity.
    assert expected_decoded_pixels("GRB", blocks, 3) == [RED, GREEN, BLUE]


def test_expected_decoded_pixels_clips_and_clears():
    # Uncovered LEDs stay off; painting past the end is clipped.
    assert expected_decoded_pixels("RGB", [(0, 10, RED)], 3) == [GREEN] * 3
    assert expected_decoded_pixels("BGR", [(1, 1, RED)], 3) == [
        (0, 0, 0),
        la_decoded("BGR", RED),
        (0, 0, 0),
    ]
