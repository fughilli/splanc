"""pytest-homeassistant-custom-component fixtures for the Splanc integration."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# custom_components/ lives at the repo root (the HACS layout); the fake lamp one
# level up (outside tests/, which holds only test_*.py).
HERE = Path(__file__).resolve().parent
for path in (HERE.parents[2], HERE.parent):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from fake_lamp import FakeLamp  # noqa: E402


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations, socket_enabled):
    """Custom integrations on, and real sockets: the fake lamp is a real wss
    server on 127.0.0.1."""
    yield


@pytest.fixture
async def lamp():
    fake = FakeLamp()
    await fake.start()
    yield fake
    await fake.stop()


@pytest.fixture
async def old_lamp():
    """Firmware without the "power" feature."""
    fake = FakeLamp(power=False)
    await fake.start()
    yield fake
    await fake.stop()
