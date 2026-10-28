"""HITL test selection (pi/hitl/ci/select_core.py + overrides.toml).

The policy that decides which on-hardware tests a PR / merge group runs. Pinned
here: the fail-safe paths (anything unsure runs everything), narrowing stages can
only remove and fall back to "keep" when unsure, the override map's reviewed rules,
and the outcome on last week's real merged PRs (their file lists and the impacted
targets Target Determinator reported for them, recorded in testdata).
"""

import json
import os
from pathlib import Path

import pytest
import select_core as sc

POOL = [
    "//pi/hitl/harness:e2e_netstack",
    "//pi/hitl/harness:fx_bench_netstack",
    "//pi/hitl/harness:improv_e2e_led-mapper-pi",
    "//pi/hitl/harness:rig_isolation",
]
WEB_OTA = "//pi/hitl/harness:web_ota_journey"


def _repo_file(relpath):
    try:
        from python.runfiles import runfiles as _rf

        r = _rf.Create()
        if r:
            p = r.Rlocation("_main/" + relpath)
            if p and Path(p).is_file():
                return Path(p)
    except Exception:  # noqa: BLE001 - no runfiles: fall back to the source tree
        pass
    for base in Path(__file__).absolute().parents:
        cand = base / relpath
        if cand.is_file():
            return cand
    if os.environ.get("TEST_SRCDIR"):
        pytest.fail(f"{relpath} missing from the test's runfiles (BUILD data)")
    pytest.skip(f"{relpath} not found")


@pytest.fixture(scope="module")
def rules():
    return sc.load_rules(_repo_file("pi/hitl/ci/overrides.toml").read_text())


def _sel(files, impacted, rules, **kw):
    return sc.select(POOL, files, impacted, rules=rules, **kw)


# --- fail safe -------------------------------------------------------------


def test_force_all_runs_every_pool_test_without_calling_it_unsure(rules):
    s = _sel(["web/src/main.ts"], [], rules, force_all="push to main: full suite")
    assert s.mode == sc.ALL and s.pool == POOL
    assert s.fail_safe is None


@pytest.mark.parametrize(
    "files,impacted,kw,why,lanes_on",
    [
        # no diff: nothing is known, so the path-selected phone lanes run too
        (None, [], {}, "changed-file list unavailable", True),
        # no bazel impact: the pool runs whole; the lanes still follow their paths
        (["web/src/main.ts"], None, {"impact_error": "cquery failed"}, "cquery failed", False),
    ],
)
def test_unsure_inputs_run_everything(rules, files, impacted, kw, why, lanes_on):
    s = _sel(files, impacted, rules, **kw)
    assert s.mode == sc.ALL and s.pool == POOL
    assert why in s.fail_safe
    assert all(s.lanes.values()) == lanes_on


def test_unusable_override_map_runs_everything():
    s = sc.select(POOL, ["web/src/main.ts"], [], rules=None, rules_error="bad toml")
    assert s.mode == sc.ALL and "bad toml" in s.fail_safe


@pytest.mark.parametrize(
    "text",
    [
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\n",  # selects nothing
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\npool='some'\n",
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\nlanes=['pixel']\n",
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\ntests=['pi/x']\n",
        "[[rule]]\nid='x'\npaths=['a']\npool='all'\n",  # no why
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\npool='all'\ntypo=1\n",
        "[[rule]]\nid='x'\nwhy='y'\npaths=['a']\npool='all'\n" * 2,  # duplicate id
        "[[rul]]\n",
        "not toml [",
    ],
)
def test_malformed_override_map_is_rejected(text):
    with pytest.raises(sc.RulesError):
        sc.load_rules(text)


def test_a_pool_test_outside_the_bazel_universe_is_kept(rules):
    universe = POOL[:-1]
    s = _sel(["docs/x.md"], [], rules, impact_universe=universe)
    assert s.pool == [POOL[-1]]
    assert "outside the bazel-impact universe" in s.tests[POOL[-1]]["why"][0]["why"]


# --- bazel impact + overrides ---------------------------------------------


def test_nothing_impacted_and_no_override_runs_nothing(rules):
    s = _sel(["agent/src/tools.ts", "docs/whats-new.md"], [], rules)
    assert s.mode == sc.NONE and s.pool == [] and not any(s.lanes.values())
    assert s.tests[POOL[0]] == {
        "lane": "pool",
        "kept": False,
        "why": [{"stage": "bazel", "why": "not impacted"}],
    }


def test_bazel_impacted_tests_run(rules):
    s = _sel(["firmware/fx_vm/vm.rs"], POOL[:2] + ["//firmware/fx_vm:vm"], rules)
    assert s.mode == sc.SOME and s.pool == POOL[:2]


@pytest.mark.parametrize(
    "path",
    [".github/workflows/hitl.yaml", "pi/hitl/ci/select_core.py", "pi/hitl/reserve/catalog.json"],
)
def test_lane_selection_and_rig_config_run_everything(rules, path):
    s = _sel([path], [], rules)
    assert s.mode == sc.ALL
    assert s.tests[POOL[0]]["why"][0]["stage"] == "override"


def test_web_ota_code_selects_the_web_ota_journey(rules):
    s = _sel(["web/src/net/otaUpdate.ts"], [], rules)
    assert s.pool == [] and s.web == [WEB_OTA]
    assert s.lanes["android"], "web/src/net is also an Android-journey path"


@pytest.mark.parametrize(
    "path,android,ios",
    [
        ("web/src/net/client.ts", True, False),
        ("web/src/driver/harness.ts", True, True),
        ("web/src/ui/screens/addDevice.ts", True, False),
        ("web/capacitor.config.ts", False, True),
        ("pi/hitl/phone/ios_journeys.py", True, True),
        ("pi/hitl/phone/journeys/connect.py", True, True),
        ("firmware/netstack/tcp.c", True, False),
        ("web/src/ui/screens/effects.ts", False, False),
    ],
)
def test_phone_lanes_keep_their_path_opt_ins(rules, path, android, ios):
    s = _sel([path], [], rules)
    assert s.lanes == {"android": android, "ios": ios}


def test_glob_semantics():
    rx = sc.glob_to_regex("web/src/flash/**")
    assert rx.match("web/src/flash/a.ts") and rx.match("web/src/flash/x/y.ts")
    assert not rx.match("web/src/flashy.ts")
    one = sc.glob_to_regex("pi/hitl/phone/ios_*")
    assert one.match("pi/hitl/phone/ios_journeys.py") and not one.match("pi/hitl/phone/ios_/x")
    assert sc.glob_to_regex("**/BUILD.bazel").match("BUILD.bazel")


# --- narrowing stages ------------------------------------------------------


def _stage(result):
    return sc.Stage("t", lambda cands, ctx: result(cands) if callable(result) else result)


def test_a_confident_stage_drops_and_says_why(rules):
    st = _stage(sc.Drop({POOL[1]: "no requirement of this PR is verified by it"}))
    s = _sel(["firmware/x.c"], POOL[:2], rules, stages=[st])
    assert s.pool == [POOL[0]]
    assert s.tests[POOL[1]]["why"] == [
        {"stage": "t", "why": "no requirement of this PR is verified by it"}
    ]


@pytest.mark.parametrize(
    "result",
    [
        sc.Unknown("no traceability for these files"),
        sc.Drop({POOL[3]: "not a candidate"}),  # may only remove candidates
        lambda cands: 1 / 0,  # a broken stage
    ],
)
def test_an_unsure_or_broken_stage_keeps_everything(rules, result):
    s = _sel(["firmware/x.c"], POOL[:2], rules, stages=[_stage(result)])
    assert s.pool == POOL[:2]
    assert s.stages[-1]["result"] == "unknown"


def test_an_override_beats_a_narrowing_drop(rules):
    st = _stage(sc.Drop({POOL[0]: "x"}))
    s = _sel([".github/workflows/hitl.yaml"], POOL[:1], rules, stages=[st])
    assert s.mode == sc.ALL


def test_every_test_has_a_machine_readable_explanation(rules):
    s = _sel(["web/src/net/otaUpdate.ts", "firmware/x.c"], POOL[:1], rules)
    doc = json.loads(json.dumps(s.to_json()))
    for t, v in doc["tests"].items():
        assert isinstance(v["kept"], bool) and v["why"], t
        assert all("stage" in w for w in v["why"]), t


# --- last week's real merged PRs ------------------------------------------


def _real_prs():
    data = json.loads(_repo_file("pi/hitl/tests/testdata/hitl_select_prs.json").read_text())
    for pr in data["prs"]:
        pr["pool"] = data["pools"][pr["pool"]]
    return data


def test_recorded_prs_select_as_recorded(rules):
    data = _real_prs()
    counts = {sc.NONE: 0, sc.SOME: 0, sc.ALL: 0}
    for pr in data["prs"]:
        s = sc.select(pr["pool"], pr["files"], pr["impacted"], rules=rules)
        counts[s.mode] += 1
        assert s.mode == pr["expect_mode"], (pr["number"], s.mode, pr["expect_mode"])
        assert len(s.pool) == pr["expect_count"], pr["number"]
    assert counts == data["expect_counts"]


def test_device_free_prs_run_no_pool_test(rules):
    # web / agent / docs-only PRs: the bulk of last week's volume.
    device_free = ("web/", "agent/", "docs/")
    for pr in _real_prs()["prs"]:
        if all(f.startswith(device_free) for f in pr["files"]):
            s = sc.select(pr["pool"], pr["files"], pr["impacted"], rules=rules)
            assert s.pool == [], pr["number"]


def test_reservation_client_prs_run_everything(rules):
    # hitl_client (the reservation client every test imports) reaches the whole pool.
    for pr in _real_prs()["prs"]:
        if "pi/hitl/harness/hitl_client.py" in pr["files"]:
            s = sc.select(pr["pool"], pr["files"], pr["impacted"], rules=rules)
            assert s.mode == sc.ALL, pr["number"]


def test_push_runs_the_whole_pool_but_phone_lanes_still_follow_paths(rules):
    s = _sel(["web/src/net/client.ts"], None, rules, force_all="push to main")
    assert s.mode == sc.ALL and s.fail_safe is None
    assert s.lanes == {"android": True, "ios": False}
    assert s.web == [WEB_OTA]
    quiet = _sel(["docs/x.md"], None, rules, force_all="push to main")
    assert quiet.lanes == {"android": False, "ios": False} and quiet.web == []
