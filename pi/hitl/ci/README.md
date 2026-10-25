# HITL lane verdict and flake budget

The HITL lane (`.github/workflows/hitl.yaml`) runs every `hitl`-tagged test with
`--flaky_test_attempts=3` on a shared, contended bench. `hitl_verdict.py` turns that
run into the job's result.

## Verdicts

| verdict     | when                                                                   | gates? |
| ----------- | ---------------------------------------------------------------------- | ------ |
| PASS        | passed, possibly after a retry                                         | —      |
| FAIL        | at least one failing attempt that was not infra, and no attempt passed | yes    |
| INFRA       | every failing attempt was infra; re-queued once, then SKIPPED          | no     |
| QUARANTINED | listed in `quarantine.toml`; runs and reports PASS/FAIL/INFRA          | no     |

Infra (`verdict_core.classify_attempt`) is deliberately narrow — the test never got a
fair run:

- the reservation never activated, i.e. any of hitl_client's give-ups
  (`did not activate …`): the CI deadline (`HITL_DEADLINE`), a stalled queue, an
  unhealthy rig (daemon unreachable, or no unit can serve the request), the safety
  cap, or a fixed timeout; or it was released before activating;
- no reachable rig had a matching unit;
- the rig's ssh or tunnel failed (`could not probe DUT … from the rig (ssh …)`,
  `tunnel … did not come up`), or its daemon answered with an HTTP error;
- bazel killed the test while it was still queued (a `queued:` line, no `reserved:`).

A DUT that won't boot, join Wi-Fi, lease, open its socket, or that drops off the
network is **not** infra: that can be the firmware under test. Those count against
the test's flake budget. A failure marker in the test's own output (`AssertionError`,
`FAIL`, `verdict=FAIL`, `PROBLEM:`, `off-margin`) always makes the attempt a test
failure, unless the line is itself the reserve error the harness reports.

## Flake budget

Measured with `flake_report.py` over the trailing 7 days of hitl.yaml runs (main
pushes, the periodic dispatch runs, PRs and merge groups), counting only non-infra
attempts:

- **attempt failure rate** = non-infra failing attempts / non-infra attempts;
- **flaky runs** = runs where the test failed and then passed on the same commit
  (proof the failure isn't the change under test);
- **red runs on main** = push/dispatch runs where every attempt failed, not on infra.

A test is a **quarantine candidate** when all of:

1. at least 20 non-infra attempts in the window (enough data), and
2. at least 3 flaky runs (it fails without a code change), and
3. an attempt failure rate of 20% or more, **or** at least 2 red runs on main.

The lane's budget is a non-infra attempt failure rate under 5% per test; anything
above that is worth an issue even below the quarantine bar.

Quarantining is a reviewed change to `quarantine.toml`: every entry names the test,
the reason (with the numbers), an issue, an owner, the date and a review date at
most 14 days out. Quarantined tests keep running, so the data keeps coming. **Exit**
when a fix has landed and the test has had 20 consecutive runs without a non-infra
failure, or re-decide at the review date (the verdict summary flags entries past it).
Never quarantine a test whose failures started with a specific change: that's a
regression, revert or fix it.
