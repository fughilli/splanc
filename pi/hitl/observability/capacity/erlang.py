"""Erlang-C (M/M/c) queueing math for the HITL capacity model. Stdlib only.

Notation: ``c`` servers (boards), arrival rate ``lam`` (requests/s), mean hold
``hold`` (s, so the service rate is mu = 1/hold), offered load ``a = lam * hold``
in Erlangs (boards' worth of work). Everything is per pool of interchangeable
boards.

Wait-time tails:

* FIFO M/M/c: an arrival waits with probability C(c, a) (Erlang C), and given that
  it waits the wait is exponential with rate c*mu - lam, so
  ``P(W > t) = C * exp(-(c*mu - lam) t)`` (exact).
* Non-preemptive priority, equal hold for all classes (Cobham): class k's mean wait
  is ``C / (c*mu) / ((1 - s_{k-1}) (1 - s_k))`` with ``s_k`` the cumulative load of
  classes 1..k divided by c. We keep the FIFO probability of waiting (an arrival
  finds every board busy with probability C regardless of its class) and give the
  conditional wait an exponential tail with Cobham's mean. For the top class that
  is ``P(W1 > t) = C * exp(-(c*mu - lam1) t)``; its mean is exact and the tail is a
  close approximation (checked against a simulation in the tests).
* G/G/c (bursty arrivals / skewed holds): Allen-Cunneen scales the conditional
  wait by ``k = (ca2 + cs2) / 2`` (squared coefficients of variation of
  inter-arrival and hold times). ``k = 1`` is M/M/c.
"""

from __future__ import annotations

import math


def erlang_b(c: int, a: float) -> float:
    """Erlang B blocking probability for c servers at offered load a (stable recurrence)."""
    if c < 0:
        raise ValueError("c must be >= 0")
    if a <= 0:
        return 0.0 if c > 0 else 1.0
    b = 1.0
    for k in range(1, c + 1):
        b = a * b / (k + a * b)
    return b


def erlang_c(c: int, a: float) -> float:
    """Probability an arrival has to wait in M/M/c (1.0 when a >= c: unstable)."""
    if c <= 0:
        return 1.0
    if a <= 0:
        return 0.0
    if a >= c:
        return 1.0
    b = erlang_b(c, a)
    return b / (1.0 - (a / c) * (1.0 - b))


def wait_tail_params(
    c: int,
    lam: float,
    hold: float,
    *,
    ahead_load: float = 0.0,
    own_load: float | None = None,
    variability: float = 1.0,
) -> tuple[float, float]:
    """(p_wait, rate) such that P(W > t) = p_wait * exp(-rate * t).

    ``lam`` is the TOTAL arrival rate into the pool (all priority classes); the
    class being evaluated has cumulative load ``ahead_load`` (classes strictly
    ahead of it, in Erlangs) and ``own_load`` (its own, in Erlangs; default: all of
    ``lam``, i.e. FIFO). rate is 0 when that class is unstable (infinite wait).
    """
    if c <= 0:
        return 1.0, 0.0
    if lam <= 0 or hold <= 0:
        return 0.0, math.inf
    a = lam * hold
    if own_load is None:
        own_load = a - ahead_load
    p = erlang_c(c, a)
    s_prev = ahead_load / c
    s_k = (ahead_load + own_load) / c
    if s_k >= 1.0:
        return p, 0.0
    # Cobham mean conditional wait: hold / c / ((1 - s_prev)(1 - s_k)); FIFO is the
    # case s_prev = 0, s_k = a / c, which gives 1 / (c*mu - lam).
    cond_mean = hold / c / ((1.0 - s_prev) * (1.0 - s_k)) * variability
    return p, 1.0 / cond_mean


def wait_tail(t: float, c: int, lam: float, hold: float, **kw) -> float:
    """P(W > t)."""
    p, rate = wait_tail_params(c, lam, hold, **kw)
    if p <= 0:
        return 0.0
    if rate == 0:
        return p
    return p * math.exp(-rate * t)


def wait_quantile(q: float, c: int, lam: float, hold: float, **kw) -> float:
    """The q-quantile of the wait (s): 0 if fewer than (1-q) of arrivals wait, inf if unstable."""
    p, rate = wait_tail_params(c, lam, hold, **kw)
    if p <= 1.0 - q:
        return 0.0
    if rate == 0:
        return math.inf
    return math.log(p / (1.0 - q)) / rate


def class_wait_quantile(
    q: float,
    c: int,
    lam: float,
    hold: float,
    *,
    policy: str,
    share_ahead: float = 0.0,
    share_own: float = 1.0,
    variability: float = 1.0,
) -> float:
    """Wait quantile for one priority class of a pool.

    ``policy='fifo'``: every class waits like the pool (shares ignored).
    ``policy='priority'``: the class holds ``share_own`` of the arrivals and the
    classes ahead of it ``share_ahead`` (fractions of lam).
    """
    a = lam * hold
    if policy == "fifo":
        return wait_quantile(q, c, lam, hold, variability=variability)
    if policy != "priority":
        raise ValueError(f"unknown policy {policy!r}")
    return wait_quantile(
        q, c, lam, hold, ahead_load=a * share_ahead, own_load=a * share_own, variability=variability
    )


def required_servers(
    lam: float,
    hold: float,
    slo_s: float,
    *,
    q: float = 0.95,
    targets: list[tuple[float, float, float]] | None = None,
    policy: str = "fifo",
    variability: float = 1.0,
    c_max: int = 1000,
) -> int:
    """Smallest c whose wait quantile meets the SLO.

    ``targets`` is a list of (share_ahead, share_own, slo_s) per guarded priority
    class (policy='priority'); by default a single FIFO target ``slo_s``.
    """
    if lam <= 0 or hold <= 0:
        return 0
    if targets is None:
        targets = [(0.0, 1.0, slo_s)]
    a = lam * hold
    # Every policy needs a stable pool overall (c > a): under priority scheduling an
    # overloaded pool still serves the top class, but the bottom class (dev) would
    # wait forever.
    c = max(1, math.floor(a) + 1)
    while c <= c_max:
        ok = all(
            class_wait_quantile(
                q,
                c,
                lam,
                hold,
                policy=policy,
                share_ahead=sa,
                share_own=so,
                variability=variability,
            )
            <= slo
            for sa, so, slo in targets
            if so > 0 or policy == "fifo"
        )
        if ok:
            return c
        c += 1
    return c_max


def headroom(
    lam: float, hold: float, c: int, slo_s: float, *, m_max: float = 10.0, tol: float = 1e-3, **kw
) -> float:
    """Largest demand multiplier m (<= m_max) for which c boards still meet the SLO.

    Below 1 means today's demand already misses the SLO (demand would have to
    shrink to that fraction); 0 when even a trickle misses it. Wait quantiles grow
    monotonically with load, so bisection is exact up to ``tol``.
    """
    if c <= 0:
        return 0.0
    if lam <= 0 or hold <= 0:
        return m_max

    def ok(m: float) -> bool:
        return required_servers(lam * m, hold, slo_s, c_max=c + 1, **kw) <= c

    if not ok(1e-9):
        return 0.0
    if ok(m_max):
        return m_max
    lo, hi = 0.0, m_max
    while hi - lo > tol:
        mid = (lo + hi) / 2
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo
