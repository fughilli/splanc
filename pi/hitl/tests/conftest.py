"""Shared fixtures for the HITL pure-logic tests."""

import pytest

# Environment knobs hitl_client reads when it builds a Reservation or the runner
# pool: a developer shell (or a CI step) that exports any of them would otherwise
# change which unit/host the selection logic under test picks.
_SELECTION_ENV = (
    "HITL_SKU",
    "HITL_EXCLUDE_HOSTS",
    "HITL_TAG",
    "HITL_HOSTS",
    "HITL_SERVERS",
    "HITL_SERVER",
)


@pytest.fixture
def clean_hitl_env(monkeypatch):
    """Clear every hitl_client selection knob from the environment for one test."""
    for name in _SELECTION_ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch
