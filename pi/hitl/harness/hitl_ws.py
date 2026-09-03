"""Shared WebSocket connection tolerances for the HITL harnesses.

Every on-device test reaches the DUT over the SAME long-haul path: the test driver
(a laptop, or — in CI — a GitHub-hosted runner) -> tailscale -> the rig -> an ssh
`-L` tunnel -> the DUT on the rig's private WiFi LAN. That path is jittery (runner
latency, tailscale, and two concurrent per-DUT tunnels on one rig under load), and
it turned the harnesses' original tight timeouts (8s connect, 5-10s per reply) into
flaky connection-phase failures under contention.

That flake is PATH sensitivity, not a device bug: a `netem`-style impairment on the
driver->rig hop reproduces the exact `dropped during X (TimeoutError)` / `not up yet
(TimeoutError)` signatures, while a clean path never does, and the C6 itself absorbs
~2s of added latency without a hiccup. So the fix is to make the driver TOLERANT of a
jittery path rather than to change the firmware.

These defaults are deliberately generous so real-world jitter can't trip a
connect/reply mid-run; a genuinely dead device still fails via the (bounded) settle
budget. Every knob is env-overridable, so a local low-latency bench can tighten them
(e.g. HITL_WS_OPEN_TIMEOUT=8) and CI can loosen further if a runner region is slow.
"""

import os


def _secs(env: str, default: float) -> float:
    """Env override in seconds, falling back to `default` when unset/unparseable."""
    try:
        return float(os.environ[env])
    except (KeyError, ValueError):
        return default


# wss opening handshake (TLS 1.2 + RFC6455 upgrade): several round-trips + a ~1.4KB
# cert over the tunnel, so it is the most RTT-sensitive step.
OPEN_TIMEOUT = _secs("HITL_WS_OPEN_TIMEOUT", 25.0)

# One request -> reply exchange within a live session (hello/welcome, submit_effect,
# chunk_ack, result_ready, …). The old 5-10s tripped under mid-run path jitter.
RPC_TIMEOUT = _secs("HITL_WS_RPC_TIMEOUT", 25.0)

# Budget to (re)establish the socket, retried ~every 1.5s. Covers a cold --erase-fs
# flash + LAN cert re-issue on the FIRST connect...
CONNECT_SETTLE = _secs("HITL_WS_CONNECT_SETTLE", 90.0)

# ...and a rejoin after a mid-run drop (a heavy program can briefly wedge the link).
RECONNECT_SETTLE = _secs("HITL_WS_RECONNECT_SETTLE", 90.0)
