"""PR-36 — priority-aware, progress-driven waiting for a HITL reservation.

The reservation client no longer gives up on a fixed 2400 s activation timeout
(which failed whole CI runs during bursts with nothing wrong in the code). Against
a priority-aware hitl-reserved it:

  * sends its scheduling class ($HITL_PRIORITY: merge-queue / pr-ci / dev) and
    actor with the reservation;
  * keeps waiting while the queue makes progress, and gives up only on a STALL, an
    unhealthy rig (daemon unreachable, no unit can serve it), a hard cap or the CI
    job's deadline ($HITL_DEADLINE) — RELEASING the slot when it does;
  * releases with outcome=cancelled when interrupted while queued (no leaked slot);
  * moves off a host that is cordoned for maintenance while it waits;
  * as a DEV reservation, backs off (bounded) while every rig's GET /queue says dev
    should wait, instead of piling onto a CI burst;
  * bounds how long it holds a unit ($HITL_HOLD_MAX).

Against an old daemon (no queue-progress fields) the legacy fixed timeout applies
unchanged. Pure logic: daemon HTTP, sockets, clock and sleeps are stubbed.
"""

import hitl_client
import pytest
from hitl_client import QueueWatch, Reservation, ReserveError, WaitPolicy

pytestmark = [pytest.mark.requirements("PR-36"), pytest.mark.usefixtures("clean_hitl_env")]

_ENV = (
    "HITL_PRIORITY",
    "HITL_ACTOR",
    "HITL_DEADLINE",
    "HITL_ACTIVATE_TIMEOUT",
    "HITL_ACTIVATE_MAX",
    "HITL_QUEUE_STALL_TIMEOUT",
    "HITL_RIG_UNREACHABLE_TIMEOUT",
    "HITL_HOLD_MAX",
    "HITL_BACKOFF",
    "HITL_BACKOFF_MAX",
)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for n in _ENV:
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setattr(hitl_client, "_TERMINATING", False)


class Clock:
    """Fake time.time/time.sleep: sleeping advances the clock instantly."""

    def __init__(self, t=1_000_000.0):
        self.t = t
        self.sleeps = []

    def time(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(hitl_client.time, "time", c.time)
    monkeypatch.setattr(hitl_client.time, "sleep", c.sleep)
    monkeypatch.setattr(hitl_client, "_wait_port", lambda *a, **k: True)
    return c


def _queued(pos=1, since=0, eta=600, blocked="", priority="pr-ci"):
    v = {"state": "queued", "position": pos, "priority": priority, "since_progress_seconds": since}
    if eta is not None:
        v["eta_seconds"] = eta
    if blocked:
        v["blocked"] = blocked
    return v


ACTIVE = {
    "state": "active",
    "endpoint": {"host": "x", "port": 2222, "user": "agent"},
    "unit": "c6-a",
}


def _mk(server="http://hitl-rig-1:8087", rid="res-1"):
    r = Reservation(server=server)
    r.id = rid
    r._reserve_body = {"owner": "t", "ssh_public_key": "k", "priority": "pr-ci"}
    return r


def _record_posts(monkeypatch, replies=None):
    posts = []

    def fake_post(url, body=None, timeout=15.0):
        posts.append((url, body))
        for suffix, reply in (replies or {}).items():
            if url.endswith(suffix):
                return reply
        return {}

    monkeypatch.setattr(hitl_client, "_post", fake_post)
    return posts


# --- the reserve request -------------------------------------------------------


def test_reserve_body_carries_priority_and_actor(monkeypatch):
    monkeypatch.setenv("HITL_PRIORITY", "Merge-Queue")
    r = Reservation(server="http://h1:8087")
    assert r.priority == "merge-queue" and r.actor == "agent"
    monkeypatch.setattr(r, "_gen_key", lambda: None)
    r._keyfile = "/nonexistent"
    monkeypatch.setattr(
        "builtins.open", lambda *a, **k: __import__("io").StringIO("ssh-ed25519 AAAA")
    )
    monkeypatch.setattr(r, "_pick_server", lambda: "http://h1:8087")
    monkeypatch.setattr(r, "_start_heartbeat", lambda: None)
    monkeypatch.setattr(r, "_serial_start", lambda: None)
    waits = []
    monkeypatch.setattr(r, "_await_active", lambda t=None: waits.append(t))
    posts = _record_posts(monkeypatch, {"/reserve": {"id": "abc"}})
    r.acquire()
    url, body = posts[0]
    assert url == "http://h1:8087/reserve"
    assert body["priority"] == "merge-queue" and body["actor"] == "agent"
    # No $HITL_ACTIVATE_TIMEOUT: no fixed cap is passed (progress-driven wait).
    assert waits == [None]


def test_priority_defaults_to_dev():
    assert Reservation(server="http://h1:8087").priority == "dev"


# --- WaitPolicy / QueueWatch: the give-up rules -----------------------------------


def test_legacy_daemon_keeps_the_fixed_timeout():
    w = QueueWatch(WaitPolicy(), now=0)
    w.observe({"state": "queued", "position": 3}, now=10)  # no `priority`: old daemon
    assert not w.aware
    assert w.verdict(2399) is None
    assert w.verdict(2400) == "within 2400s"


def test_aware_daemon_waits_past_2400s_while_the_queue_progresses():
    w = QueueWatch(WaitPolicy(stall_timeout=3600), now=0)
    for t in range(0, 4 * 3600, 600):  # 4 h, the queue draining every 10 min
        w.observe(_queued(pos=5, since=30), now=t)
        assert w.verdict(t) is None, t
    assert w.aware


def test_aware_daemon_gives_up_on_a_stall():
    w = QueueWatch(WaitPolicy(stall_timeout=3600), now=0)
    w.observe(_queued(since=0), now=0)
    w.observe(_queued(since=3000), now=3000)
    assert w.verdict(3000) is None
    w.observe(_queued(since=3600), now=3600)
    assert "queue stalled" in w.verdict(3600)


def test_client_seen_position_drop_counts_as_progress():
    w = QueueWatch(WaitPolicy(stall_timeout=100), now=0)
    w.observe(_queued(pos=4, since=0), now=0)
    w.observe(_queued(pos=3, since=99), now=99)  # daemon clock lags; we saw the drop
    assert w.verdict(150) is None
    assert w.verdict(200) is not None


def test_deadline_and_hard_cap_apply_to_any_daemon():
    w = QueueWatch(WaitPolicy(deadline=500), now=0)
    w.observe(_queued(), now=0)
    assert w.verdict(499) is None and "HITL_DEADLINE" in w.verdict(500)
    legacy = QueueWatch(WaitPolicy(deadline=500), now=0)
    legacy.observe({"state": "queued", "position": 1}, now=0)
    assert "HITL_DEADLINE" in legacy.verdict(500)
    capped = QueueWatch(WaitPolicy(hard_cap=100), now=0)
    capped.observe(_queued(), now=0)
    assert capped.verdict(100) == "within 100s"


def test_unhealthy_rig_unreachable_or_no_unit():
    w = QueueWatch(WaitPolicy(unreachable_timeout=300), now=0)
    w.observe(_queued(), now=0)
    w.observe_unreachable(10)
    assert w.verdict(309) is None
    assert "unreachable" in w.verdict(310)
    w.observe(_queued(), now=320)  # back: the unreachable clock clears
    assert w.verdict(320) is None

    nb = QueueWatch(WaitPolicy(blocked_timeout=300), now=0)
    nb.observe(_queued(blocked="no-unit", eta=None), now=0)
    assert nb.verdict(299) is None
    assert "no unit" in nb.verdict(300)


def test_policy_from_env(monkeypatch):
    monkeypatch.setenv("HITL_DEADLINE", "12345")
    monkeypatch.setenv("HITL_QUEUE_STALL_TIMEOUT", "900")
    p = WaitPolicy.from_env()
    assert p.deadline == 12345 and p.stall_timeout == 900 and p.hard_cap is None
    assert p.legacy_timeout == 2400
    p = WaitPolicy.from_env(timeout=50)
    assert p.hard_cap == 50 and p.legacy_timeout == 50
    p = WaitPolicy.from_env(timeout=None, legacy_timeout=3000)
    assert p.hard_cap is None and p.legacy_timeout == 3000


def test_log_line_shows_class_eta_and_stall():
    w = QueueWatch(WaitPolicy(), now=0)
    line = w.observe(_queued(pos=2, since=0, eta=420), now=0)
    assert line == "queued: position 2 class=pr-ci eta~7m00s"
    assert w.observe(_queued(pos=2, since=30, eta=420), now=30) is None  # unchanged
    line = w.observe(_queued(pos=2, since=90, eta=420), now=90)  # a minute later: reprint
    assert line.endswith("(no queue progress for 1m30s)")


# --- _await_active end to end (fake clock) -----------------------------------------


def test_await_active_outlasts_the_old_2400s_timeout(monkeypatch, clock):
    # 3 h in queue with steady progress, then active: the old client would have
    # failed this run at 40 min.
    start = clock.t

    def fake_get(url, timeout=10.0):
        if clock.t - start >= 3 * 3600:
            return ACTIVE
        return _queued(pos=2, since=60)

    monkeypatch.setattr(hitl_client, "_get", fake_get)
    posts = _record_posts(monkeypatch)
    r = _mk()
    r._await_active()
    assert r.port == 2222 and r._unit == "c6-a"
    assert not posts  # never released


def test_await_active_releases_and_raises_on_a_stall(monkeypatch, clock):
    start = clock.t
    monkeypatch.setattr(
        hitl_client, "_get", lambda url, timeout=10.0: _queued(since=int(clock.t - start))
    )
    posts = _record_posts(monkeypatch)
    r = _mk()
    with pytest.raises(ReserveError) as e:
        r._await_active()
    assert "reservation res-1 did not activate (queue stalled" in str(e.value)
    assert any(u.endswith("/reservation/res-1/release") for u, _ in posts)
    assert 3600 <= clock.t - start < 3700


def test_interrupt_while_queued_releases_as_cancelled(monkeypatch, clock):
    calls = {"n": 0}

    def fake_get(url, timeout=10.0):
        calls["n"] += 1
        if calls["n"] == 3:
            raise KeyboardInterrupt
        return _queued()

    monkeypatch.setattr(hitl_client, "_get", fake_get)
    posts = _record_posts(monkeypatch)
    r = _mk()
    with pytest.raises(KeyboardInterrupt):
        r._await_active()
    assert [u for u, _ in posts] == [
        "http://hitl-rig-1:8087/reservation/res-1/release?outcome=cancelled"
    ]
    assert r.id is None


def test_sigterm_flag_marks_release_cancelled(monkeypatch):
    posts = _record_posts(monkeypatch)
    monkeypatch.setattr(hitl_client, "_TERMINATING", True)
    r = _mk()
    r.release()
    assert posts[0][0].endswith("/release?outcome=cancelled")
    monkeypatch.setattr(hitl_client, "_TERMINATING", False)
    r = _mk()
    r.release()
    assert posts[1][0].endswith("/reservation/res-1/release")


def test_migrates_off_a_host_cordoned_while_waiting(monkeypatch, clock):
    monkeypatch.setenv("HITL_HOSTS", "hitl-rig-1 hitl-rig-2")
    rig1, rig2 = "http://hitl-rig-1:8087", "http://hitl-rig-2:8087"
    unit = {"name": "c6-b", "type": "esp32c6", "capabilities": [], "active": {"id": "x"}}

    def fake_get(url, timeout=10.0):
        if url == rig2 + "/status":
            return {"units": [unit]}
        if url == rig1 + "/reservation/res-1":
            return _queued(blocked="cordoned", eta=None, since=int(clock.t))
        if url == rig2 + "/reservation/new-1":
            return ACTIVE
        raise AssertionError(url)

    monkeypatch.setattr(hitl_client, "_get", fake_get)
    posts = _record_posts(monkeypatch, {rig2 + "/reserve": {"id": "new-1"}})
    r = Reservation()  # not pinned to a server: free to move
    r.server, r.id = rig1, "res-1"
    r._reserve_body = {"owner": "t", "ssh_public_key": "k"}
    t0 = clock.t
    r._await_active()
    urls = [u for u, _ in posts]
    assert urls == [rig2 + "/reserve", rig1 + "/reservation/res-1/release"]
    assert r.server == rig2 and r.id == "new-1" and r.port == 2222
    assert clock.t - t0 >= 120  # waited the cordon grace first


def test_pinned_server_never_migrates(monkeypatch, clock):
    monkeypatch.setenv("HITL_HOSTS", "hitl-rig-1 hitl-rig-2")
    monkeypatch.setenv("HITL_QUEUE_STALL_TIMEOUT", "600")
    monkeypatch.setattr(
        hitl_client,
        "_get",
        lambda url, timeout=10.0: _queued(blocked="cordoned", eta=None, since=0),
    )
    posts = _record_posts(monkeypatch)
    r = _mk()  # server given explicitly => pinned
    # A pinned client waits in place on its cordoned host (here until the hard cap)
    # and never re-reserves elsewhere.
    with pytest.raises(ReserveError):
        r._await_active(timeout=300)
    assert not any(u.endswith("/reserve") for u, _ in posts)


# --- dev back-off --------------------------------------------------------------------


def _fleet(monkeypatch, retry_by_host, queue_404=False):
    def fake_get(url, timeout=10.0):
        base, _, path = url.rpartition("/")
        if path == "status":
            return {
                "units": [{"name": "c6-a", "type": "esp32c6", "capabilities": [], "active": None}]
            }
        if path == "queue":
            if queue_404:
                raise hitl_client.urllib.error.HTTPError(url, 404, "nf", {}, None)
            return {"types": [{"type": "esp32c6", "retry_after_seconds": retry_by_host[base]}]}
        raise AssertionError(url)

    monkeypatch.setattr(hitl_client, "_get", fake_get)


def test_dev_backs_off_while_every_rig_says_wait(monkeypatch, clock):
    monkeypatch.setenv("HITL_HOSTS", "h1 h2")
    hints = {"http://h1:8087": 600, "http://h2:8087": 300}
    _fleet(monkeypatch, hints)
    r = Reservation()

    def sleep(s):
        clock.sleeps.append(s)
        clock.t += s
        hints["http://h2:8087"] = 0  # h2 clears after one back-off

    monkeypatch.setattr(hitl_client.time, "sleep", sleep)
    r._dev_backoff()
    assert len(clock.sleeps) == 1 and 240 <= clock.sleeps[0] <= 360  # 300 s ± 20 %


def test_dev_backoff_is_bounded(monkeypatch, clock):
    monkeypatch.setenv("HITL_HOSTS", "h1")
    monkeypatch.setenv("HITL_BACKOFF_MAX", "1000")
    _fleet(monkeypatch, {"http://h1:8087": 600})
    t0 = clock.t
    Reservation()._dev_backoff()
    assert clock.t - t0 == pytest.approx(1000, abs=1)  # then enqueues anyway


def test_dev_backoff_skips_old_daemons_and_ci(monkeypatch, clock):
    monkeypatch.setenv("HITL_HOSTS", "h1")
    _fleet(monkeypatch, {}, queue_404=True)
    Reservation()._dev_backoff()
    assert clock.sleeps == []
    monkeypatch.setenv("HITL_BACKOFF", "0")
    _fleet(monkeypatch, {"http://h1:8087": 600})
    Reservation()._dev_backoff()
    assert clock.sleeps == []


# --- hold watchdog + queue_status ---------------------------------------------------


def test_hold_watchdog_terminates_after_hold_max(monkeypatch):
    monkeypatch.setenv("HITL_HOLD_MAX", "3600")
    timers = []

    class FakeTimer:
        def __init__(self, interval, fn):
            self.interval, self.fn, self.cancelled, self.daemon = interval, fn, False, False
            timers.append(self)

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

    kills = []
    monkeypatch.setattr(hitl_client.threading, "Timer", FakeTimer)
    monkeypatch.setattr(hitl_client.os, "kill", lambda pid, sig: kills.append(sig))
    r = _mk()
    r._start_hold_watchdog()
    assert timers[0].interval == 3600
    timers[0].fn()
    assert kills == [hitl_client.signal.SIGTERM]
    _record_posts(monkeypatch)
    r.release()
    assert timers[0].cancelled


def test_no_hold_watchdog_by_default(monkeypatch):
    monkeypatch.setattr(hitl_client.threading, "Timer", lambda *a: pytest.fail("no timer expected"))
    _mk()._start_hold_watchdog()


def test_queue_status_reports_unavailable_hosts(monkeypatch):
    def fake_get(url, timeout=10.0):
        if url.startswith("http://h1"):
            return {"host": "h1", "queue_length": 2, "types": [], "classes": []}
        raise OSError("down")

    monkeypatch.setattr(hitl_client, "_get", fake_get)
    out = hitl_client.queue_status(["http://h1:8087", "http://h2:8087"])
    assert out[0]["queue_length"] == 2 and out[0]["url"] == "http://h1:8087"
    assert out[1] == {"url": "http://h2:8087", "error": "down"}
