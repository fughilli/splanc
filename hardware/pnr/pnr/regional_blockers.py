"""Rank movable native collision blockers and include their full endpoints.

These are proposals only. The regional adapter must restore every removed
connection and pass native DRC, pad-entry and reference checks atomically.
"""
import math

def plans_from_rows(rows, selected_nets, bounds, *, limit=2, max_span=35):
    groups = {}
    for row in rows:
        if (row["net"] in selected_nets or row["locked"] or row["protected"]
                or row["mode"] != "signal" or row["kind"] != "PCB_TRACK"
                or abs(row["width_mm"]-.2) > 1e-8):
            continue
        groups.setdefault(row["net"], []).append(row)
    plans = []
    for net, items in groups.items():
        points = [p for item in items for p in (item["a"], item["b"])]
        box = [min(bounds[0], min(p[0] for p in points)-1),
               min(bounds[1], min(p[1] for p in points)-1),
               max(bounds[2], max(p[0] for p in points)+1),
               max(bounds[3], max(p[1] for p in points)+1)]
        box = [math.floor(box[0]*20)/20, math.floor(box[1]*20)/20,
               math.ceil(box[2]*20)/20, math.ceil(box[3]*20)/20]
        if max(box[2]-box[0], box[3]-box[1]) > max_span:
            continue
        plans.append(dict(net=net, hits=sum(x["hits"] for x in items),
                          bounds=box, blockers=[x["uuid"] for x in items]))
    return sorted(plans, key=lambda x: (-x["hits"], x["net"]))[:limit]

def inspect(board, rules, report, selected_nets, bounds, sources=()):
    from pnr.native_electrical import uid, xy
    from pnr.electrical import net_policy
    from pnr.via_coalesce import protected
    excluded, _ = protected(board, rules, sources)
    objects = {uid(t): t for t in board.GetTracks()}
    rows = []
    for identity, hits in report.get("static_blockers", {}).items():
        track = objects.get(identity)
        if track is None:
            continue
        name = track.GetNetname()
        rows.append(dict(uuid=identity, hits=hits, net=name,
                         kind=track.GetClass(), locked=track.IsLocked(),
                         protected=name in excluded,
                         mode=net_policy(name, rules)["mode"],
                         width_mm=track.GetWidth()/1e6,
                         a=xy(track.GetStart()), b=xy(track.GetEnd())))
    return dict(rows=rows, plans=plans_from_rows(rows, selected_nets, bounds))

def main():
    import argparse,json,pcbnew as k
    from pathlib import Path
    p=argparse.ArgumentParser();p.add_argument("board",type=Path)
    p.add_argument("--rules",type=Path,required=True);p.add_argument("--report",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True);p.add_argument("--net",action="append",default=[])
    p.add_argument("--bounds",nargs=4,type=float,required=True)
    p.add_argument("--annotation-source",type=Path,action="append",default=[])
    a=p.parse_args();board=k.LoadBoard(str(a.board))
    result=inspect(board,json.loads(a.rules.read_text()),json.loads(a.report.read_text()),a.net,a.bounds,a.annotation_source)
    a.out.write_text(json.dumps(result,indent=2))
if __name__ == "__main__": main()
