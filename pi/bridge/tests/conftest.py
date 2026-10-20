"""Shared fakes for the splanc_display tests."""

import os

import pytest


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class FakeButton:
    def __init__(self, pin):
        self.pin = pin
        self.when_pressed = None
        self.when_released = None
        self.closed = False

    def press(self):
        self.when_pressed()

    def release(self):
        self.when_released()

    def close(self):
        self.closed = True


class ButtonBank:
    """factory(pin) -> FakeButton, remembering each by pin."""

    def __init__(self):
        self.by_pin = {}

    def __call__(self, pin):
        b = FakeButton(pin)
        self.by_pin[pin] = b
        return b


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def buttons():
    return ButtonBank()


@pytest.fixture
def outdir():
    """Where render tests drop PNGs: Bazel's undeclared outputs (or $SPLANC_RENDER_OUT)."""
    d = os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR") or os.environ.get("SPLANC_RENDER_OUT")
    if d:
        os.makedirs(d, exist_ok=True)
    return d
