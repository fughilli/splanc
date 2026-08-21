"""Pure logic for the concurrent-TLS-slot churn HITL test (FUG-136).

The device's wss:443 endpoint is a heap-tight, single-task TLS server capped at
`max_open_sockets = 2` (firmware main.cpp wss_start: two ~28 KB mbedTLS sessions
already crowd the C6's heap). PR #114's "Trust & connect" wedge was ultimately a
web-client bug, but that 2-slot server is a genuine regression surface: if a slot
leaks or a stalled handshake never frees, the whole endpoint wedges until reboot
(the historical "single-task server wedge under connection churn").

`hitl_rename_wss.py` hammers *sequential* wss reconnects. The uncovered case is
*simultaneous* pressure: several wss:443 handshakes AND an HTTPS cert-page GET
competing for the two slots at once. This module holds the hardware/network-free
pieces the on-hardware driver leans on — the per-attempt outcome taxonomy and the
PASS/FAIL verdict — so they're unit-tested and can't silently drift.

The verdict encodes what "degrades gracefully" means operationally:
  * baseline — a clean wss handshake works before we pile on load;
  * recovery — after each burst of contention the server frees its slots and a
    fresh wss handshake succeeds within a bounded window (this is the anti-wedge
    gate — the regression manifests as "never recovers until reboot");
  * liveness — under contention the server still SERVES something (a wss welcome
    or the cert page) rather than going fully dark; and
  * no crash — no panic/reboot marker on the serial console during the run.
Shedding load by rejecting or timing out *excess* connections is expected and
fine; wedging or crashing is not.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Outcome buckets for one connection attempt fired during a churn burst. All of
# these except ERROR are "graceful" — a 2-slot server under contention is
# *supposed* to serve some and shed the rest by refusing/resetting/timing them
# out. A wedge doesn't show up here (each attempt still returns); it shows up as
# the post-burst recovery probe failing. ERROR is the catch-all we flag as odd.
OK = "ok"  # TLS handshake + application `welcome` completed
REJECTED = "rejected"  # cleanly refused / reset — graceful backpressure
TIMEOUT = "timeout"  # handshake stalled past the client deadline
ERROR = "error"  # anything unexpected

CATEGORIES = (OK, REJECTED, TIMEOUT, ERROR)


def classify(exc: BaseException | None) -> str:
    """Bucket one attempt from the exception it raised (None => it succeeded).

    Pinned by unit test because the on-hardware taxonomy must stay stable: a TLS
    abort under slot pressure surfaces as an SSLError/EOF and is *graceful*
    backpressure, not a fault, so it maps to REJECTED — never ERROR.
    """
    if exc is None:
        return OK
    # asyncio.TimeoutError is an alias of TimeoutError on 3.11+, but match by MRO
    # so this holds on either. A handshake we abandoned on our own deadline.
    if isinstance(exc, TimeoutError):
        return TIMEOUT
    # Connection refused/reset/aborted and TLS-layer aborts are the server
    # shedding load — the desired degradation, not a wedge.
    if isinstance(exc, (ConnectionError, BrokenPipeError, EOFError)):
        return REJECTED
    name = type(exc).__name__
    if "SSL" in name or "TLS" in name:
        return REJECTED
    # A bare OSError (e.g. ECONNRESET routed oddly, or the tunnel closing a socket)
    # is still the peer/transport dropping us, not a client logic error.
    if isinstance(exc, OSError):
        return REJECTED
    return ERROR


def tally(categories: list[str]) -> dict[str, int]:
    """Count classified attempts into a {category: count} dict over all buckets."""
    counts = {c: 0 for c in CATEGORIES}
    for c in categories:
        counts[c] = counts.get(c, 0) + 1
    return counts


@dataclass
class Round:
    """One burst of contention + its recovery probe."""

    index: int
    outcomes: dict[str, int]  # category -> count over the N concurrent handshakes
    cert_status: int | None  # HTTP status of the simultaneous cert-page GET, or None
    recovered: bool  # did a clean wss handshake work again after the burst?
    recover_s: float | None  # seconds to that first recovery (None if it never did)

    @property
    def served(self) -> int:
        """wss handshakes that reached `welcome` while under contention."""
        return self.outcomes.get(OK, 0)

    @property
    def cert_ok(self) -> bool:
        return self.cert_status == 200

    @property
    def alive_under_load(self) -> bool:
        """Did the server serve *anything* during the burst (not fully dark)?"""
        return self.served > 0 or self.cert_ok


@dataclass
class Verdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)


def verdict(baseline_ok: bool, rounds: list[Round], crashed: bool) -> Verdict:
    """Decide PASS/FAIL from the baseline, the per-round results, and the serial.

    Hard gates (any failure => FAIL):
      * the baseline clean handshake must have worked (else the run proves
        nothing about *degradation*);
      * the server must RECOVER after the final burst — i.e. `rounds[-1]`
        recovered within its window. This is the ticket's "recovering afterward"
        and the anti-wedge gate: the historical bug is a TLS server that never
        serves again until reboot, which fails here persistently. A *single*
        earlier round that takes longer than its window to free a slot but
        recovers by the next burst is graceful slow degradation on a heap-tight
        board, not a wedge — it's reported (see result_line's recovered=x/N) but
        not failed, so transient timing doesn't red-line a healthy device; and
      * no crash/reboot marker on serial.

    Reported but NOT gated (visible in the RESULT line for a reviewer): per-round
    served/cert counts and how many rounds recovered. A momentary blackout under
    LRU-slot thrash that still recovers afterward is "sheds/queues rather than
    wedging", which is the desired behavior — not a failure.
    """
    reasons: list[str] = []
    if not baseline_ok:
        reasons.append("baseline wss handshake never succeeded (cannot assess degradation)")
    if not rounds:
        reasons.append("no churn rounds ran")
    elif not rounds[-1].recovered:
        last = rounds[-1]
        reasons.append(
            f"wss did not recover after the final burst within the window "
            f"(persistent wedge; last round served={last.served} cert={last.cert_status}; "
            f"recovered {sum(1 for r in rounds if r.recovered)}/{len(rounds)} rounds)"
        )
    if crashed:
        reasons.append("device crash/reboot marker seen on serial during churn")
    return Verdict(ok=not reasons, reasons=reasons)


# Overall run status. SKIP is distinct from FAIL on purpose: if we never got a
# clean baseline handshake, we could not reach the device to test it at all — an
# infra/environment miss (a flaky Improv join, a dropped STA, wss still binding),
# NOT evidence of a wedge. A gate must only *assert* a regression once a baseline
# has proven the device was reachable; otherwise it conflates "the bench couldn't
# connect us" with "the device wedged", which is how a healthy board red-lines the
# lane. This mirrors rename_wss (and this driver's own rejoin-UNREACHABLE path),
# which exit 0 when they simply cannot test wss on a given run.
PASS = "pass"
FAIL = "fail"
SKIP = "skip"


def run_status(baseline_ok: bool, rounds: list[Round], crashed: bool) -> str:
    """Map a run to PASS / FAIL / SKIP. SKIP (no baseline) => exit 0, inconclusive.

    Only once a baseline proves the device was reachable do the verdict's hard
    gates (recovers after the final burst, no crash) decide PASS vs FAIL.
    """
    if not baseline_ok:
        return SKIP
    return PASS if verdict(baseline_ok, rounds, crashed).ok else FAIL


def result_line(baseline_ok: bool, rounds: list[Round], crashed: bool, status: str) -> str:
    """A single grep-able RESULT line for the CI log, mirroring the other benches.

    `status` is a run_status() value (pass/fail/skip); it drives the verdict field
    so an inconclusive run reads `verdict=SKIP`, not a misleading PASS/FAIL.
    """
    recovered = sum(1 for r in rounds if r.recovered)
    served_total = sum(r.served for r in rounds)
    certs_ok = sum(1 for r in rounds if r.cert_ok)
    return (
        f"RESULT rounds={len(rounds)} baseline={'ok' if baseline_ok else 'down'} "
        f"recovered={recovered}/{len(rounds)} served_total={served_total} "
        f"cert_ok={certs_ok}/{len(rounds)} crashed={'yes' if crashed else 'no'} "
        f"verdict={status.upper()}"
    )
