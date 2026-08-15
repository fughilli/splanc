"""Pure logic for the uniform-update drop-rate / bandwidth bench (DOM-free, no
hardware) so it's unit-testable. The harness (uniform_bench.py) does the I/O;
this just turns the raw counters into a result + verdict.

Drop model: we blast N `set_uniforms` over the (TCP-backed) control socket and
count the device's `playback_state` replies — the device sends one per
`set_uniforms` it dispatches, so replies < sent means the device didn't process
some, i.e. a real drop (TCP itself can't lose them). A separate ORDERED BARRIER
(a `get_effect_uniforms` sent last, whose reply arrives only after every prior
frame was processed) independently proves in-order delivery of the whole blast.
"""

from __future__ import annotations

from typing import Any


def summarize(
    label: str,
    sent: int,
    replies: int,
    bytes_sent: int,
    send_seconds: float,
    total_seconds: float,
    barrier_ok: bool,
) -> dict[str, Any]:
    """Turn raw counters into a result dict.

    - sent:          set_uniforms messages written to the socket
    - replies:       playback_state replies counted back (1 per processed message)
    - bytes_sent:    total encoded bytes of the set_uniforms messages
    - send_seconds:  wall time to write all `sent` (send-side throughput)
    - total_seconds: wall time until all replies drained (round-trip throughput)
    - barrier_ok:    the trailing get_effect_uniforms reply came back (⇒ every
                     prior set_uniforms was delivered + processed, in order)
    """
    dropped = max(0, sent - replies)
    drop_rate = dropped / sent if sent else 0.0
    return {
        "label": label,
        "sent": sent,
        "replies": replies,
        "dropped": dropped,
        "dropRatePct": round(100.0 * drop_rate, 4),
        "barrierOk": barrier_ok,
        "bytesSent": bytes_sent,
        "meanMsgBytes": round(bytes_sent / sent, 1) if sent else 0.0,
        "sendMsgsPerSec": round(sent / send_seconds, 1) if send_seconds > 0 else None,
        "sendBytesPerSec": round(bytes_sent / send_seconds, 1) if send_seconds > 0 else None,
        "roundtripMsgsPerSec": round(sent / total_seconds, 1) if total_seconds > 0 else None,
        "sendSeconds": round(send_seconds, 4),
        "totalSeconds": round(total_seconds, 4),
    }


def verdict(result: dict[str, Any]) -> tuple[bool, str]:
    """Pass/fail: the ordered barrier must confirm delivery AND no message may be
    unaccounted for (drops). On TCP both should always hold — a failure here means
    the loss is real (device-side), not the app-layer collapse this bench exists to
    rule out."""
    if not result.get("barrierOk"):
        return (
            False,
            "ordered barrier (get_effect_uniforms) never returned — blast not fully delivered",
        )
    if result.get("dropped", 0) != 0:
        return (
            False,
            f"{result['dropped']}/{result['sent']} set_uniforms had no playback_state reply "
            f"({result['dropRatePct']}% drop)",
        )
    return True, (
        f"0 drops across {result['sent']} messages; "
        f"{result.get('sendBytesPerSec')} B/s send, {result.get('meanMsgBytes')} B/msg"
    )
