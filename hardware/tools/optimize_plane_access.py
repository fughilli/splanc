import sys, json, subprocess, shutil, hashlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
from pnr.route.detail.keyhole import violation_keys
from collections import Counter
import argparse

ap = argparse.ArgumentParser(
    description="Native-gated hill climb of reviewed plane access groups; isolated KiCad edit/fill processes."
)
ap.add_argument("board", type=Path)
ap.add_argument("--inventory", type=Path, required=True)
ap.add_argument("--rules", type=Path, required=True)
ap.add_argument("--policy", type=Path, required=True)
ap.add_argument("--out-dir", type=Path, required=True)
a = ap.parse_args()
src = a.board
out = a.out_dir
out.mkdir(parents=True, exist_ok=False)
inv = json.loads(a.inventory.read_text())
pol = json.loads(a.policy.read_text())
assert (
    hashlib.sha256(src.read_bytes()).hexdigest() == inv["sha256"]
), "stale reviewed inventory"
ki = "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"
cli = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
# Build original pad partition in an isolated process.
subprocess.run(
    [
        ki,
        "-c",
        "import sys,json,pcbnew;sys.path.insert(0,'hardware/tools');from keyhole_region import pad_partition;b=pcbnew.LoadBoard(sys.argv[1]);b.BuildConnectivity();open(sys.argv[2],'w').write(json.dumps(pad_partition(b)))",
        str(src),
        str(out / "partition.json"),
    ],
    check=True,
)
current = out / "baseline.kicad_pcb"
shutil.copyfile(src, current)
shutil.copyfile(src.with_suffix(".kicad_pro"), current.with_suffix(".kicad_pro"))
(out / "fp-lib-table").write_text(
    (src.parent / "fp-lib-table")
    .read_text()
    .replace("${KIPRJMOD}", str(src.parent.resolve()))
)


def drc(p):
    subprocess.run(
        [
            cli,
            "pcb",
            "drc",
            str(p),
            "--format",
            "json",
            "--output",
            str(p.with_suffix(".drc.json")),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return json.loads(p.with_suffix(".drc.json").read_text())


before = drc(current)
initial = before
events = []
removed = set()
seq = 0
for g in inv["clusters"]:
    rule = pol["groups"][g["id"]]
    if rule.get("separate_array"):
        continue
    ids = {n["uuid"] for n in g["nodes"] if n["kind"] == "via"}
    for identity in sorted(ids):
        if len(ids - removed) <= rule.get("min_vias", 0):
            break
        seq += 1
        p = out / f"trial-{seq:03}.kicad_pcb"
        cmd = [
            ki,
            "hardware/tools/plane_access_trial.py",
            "--rules",
            str(a.rules),
            str(current),
            str(p),
            "--baseline",
            str(out / "partition.json"),
            "--via",
            identity,
        ]
        for label in rule.get("dedicated_pads", []):
            cmd += ["--dedicated", label]
        subprocess.run(cmd, check=True)
        edit = json.loads(p.with_suffix(".edit.json").read_text())
        if edit["skipped"]:
            continue
        after = drc(p)
        oldbad = {i["uuid"] for v in before["violations"] for i in v["items"]}
        pruned = []
        for count in range(6):
            dead = {
                i["uuid"]
                for v in after["violations"]
                if v["type"] == "track_dangling"
                for i in v["items"]
            } - oldbad
            if not dead:
                break
            spec = out / "prune.json"
            spec.write_text(json.dumps(sorted(dead)))
            nxt = out / f"trial-{seq:03}-prune-{count}.kicad_pcb"
            subprocess.run(
                [
                    ki,
                    "hardware/tools/plane_access_trial.py",
                    "--rules",
                    str(a.rules),
                    str(p),
                    str(nxt),
                    "--baseline",
                    str(out / "partition.json"),
                    "--prune",
                    str(spec),
                ],
                check=True,
            )
            edit = json.loads(nxt.with_suffix(".edit.json").read_text())
            pruned += edit["removed"]
            p = nxt
            after = drc(p)
            if not edit["removed"]:
                break
        counts = Counter(x["type"] for x in after["violations"])
        oldcounts = Counter(x["type"] for x in before["violations"])
        ok = (
            edit["preserved"]
            and len(after["unconnected_items"]) <= len(before["unconnected_items"])
            and not (violation_keys(after) - violation_keys(before))
            and all(
                counts[k] <= oldcounts[k] for k in ["track_dangling", "via_dangling"]
            )
        )
        e = dict(
            group=g["id"],
            via=identity,
            accepted=ok,
            pruned_tracks=pruned,
            opens=len(after["unconnected_items"]),
            violations=dict(counts),
            preserved=edit["preserved"],
            path=str(p.resolve()),
        )
        events.append(e)
        if ok:
            current = p
            before = after
            removed.add(identity)
        (out / "progress.json").write_text(
            json.dumps(dict(best=str(current.resolve()), events=events), indent=2)
        )
        print(json.dumps(e), flush=True)
final = out / "candidate.kicad_pcb"
for ext in [".kicad_pcb", ".kicad_pro", ".drc.json"]:
    shutil.copyfile(current.with_suffix(ext), final.with_suffix(ext))
(out / "result.json").write_text(
    json.dumps(
        dict(
            best=str(final.resolve()),
            removed_vias=len(removed),
            before_opens=len(initial["unconnected_items"]),
            after_opens=len(before["unconnected_items"]),
            events=events,
        ),
        indent=2,
    )
)
