"""Source-authored plane-access contracts and fabrication-dependent sizing.

Annotations are JSON in `# @pnr-plane-access {...}` comments in atopile source.
They are an explicit PnR extension, not a claim of native atopile trait support.
Targets are instance-address suffixes, never reference designators. Atomic pin
numbers describe electrical terminals; ref renumbering does not change intent.
"""

import hashlib, json, math
from pathlib import Path

KINDS = {"power_array", "thermal_reuse", "local_return"}


def positive(value, name):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ValueError(f"{name} must be finite and positive")
    return float(value)


def read_annotations(paths):
    result = []
    for path in paths:
        path = Path(path)
        data = path.read_bytes()
        for line, text in enumerate(data.decode().splitlines(), 1):
            if not text.strip().startswith("# @pnr-plane-access "):
                continue
            a = json.loads(text.strip().split("# @pnr-plane-access ", 1)[1])
            if a.get("kind") not in KINDS:
                raise ValueError("invalid plane access kind")
            if (
                not a.get("target")
                or not a.get("pads")
                or not all(isinstance(x, str) and x for x in a["pads"])
            ):
                raise ValueError("target and pad names required")
            if a["kind"] == "power_array":
                positive(a.get("rms_current_a"), "rms_current_a")
                positive(a.get("peak_current_a"), "peak_current_a")
                if a["peak_current_a"] < a["rms_current_a"]:
                    raise ValueError("peak current below RMS current")
            a["source"] = {
                "path": str(path),
                "line": line,
                "sha256": hashlib.sha256(data).hexdigest(),
            }
            result.append(a)
    return result


def resolve(annotations, components):
    result = []
    claimed = set()
    for a in annotations:
        target = a["target"].strip(".")
        matches = [
            c
            for c in components
            if c.address.removesuffix("._p") == target
            or c.address.removesuffix("._p").endswith("." + target)
        ]
        if not matches:
            raise ValueError(f"unresolved source plane-access target: {target}")
        for c in matches:
            pads = [p for p in c.pads if p.name in a["pads"]]
            if set(p.name for p in pads) != set(a["pads"]):
                raise ValueError(f"missing annotated pads on {c.address}")
            nets = {p.net for p in pads}
            if len(nets) != 1 or not next(iter(nets)):
                raise ValueError("plane-access group must have one resolved net")
            keys = {(c.address, p) for p in a["pads"]}
            if keys & claimed:
                raise ValueError("overlapping plane-access annotations")
            claimed |= keys
            result.append(dict(a, ref=c.ref, address=c.address, net=next(iter(nets))))
    return result


def size_array(intent, fab):
    """Electrical loss/drop budget, not an inferred thermal-current rating.

    Uses the full board thickness for a conservative barrel resistance even when
    access is to the first inner layer. Plating/loss/drop budgets are mandatory
    fabrication inputs; absence fails closed rather than silently using one via.
    """
    current = positive(intent["rms_current_a"], "RMS current")
    peak = positive(intent["peak_current_a"], "peak current")
    drill = positive(fab["via_drill_mm"], "drill")
    plating = positive(fab["min_via_plating_um"], "plating") / 1000
    length = positive(fab["board_thickness_mm"], "board thickness")
    rho = positive(fab["copper_resistivity_ohm_mm"], "resistivity")
    loss = positive(fab["via_barrel_loss_budget_w"], "barrel loss")
    drop = positive(fab["via_array_peak_drop_v"], "peak drop")
    area = math.pi * ((drill / 2 + plating) ** 2 - (drill / 2) ** 2)
    resistance = rho * length / area
    n = max(
        1,
        math.ceil(current * math.sqrt(resistance / loss)),
        math.ceil(peak * resistance / drop),
    )
    return dict(
        count=n,
        barrel_resistance_ohm=resistance,
        per_via_rms_a=current / n,
        per_via_loss_w=(current / n) ** 2 * resistance,
        peak_drop_v=peak * resistance / n,
        drill_mm=drill,
        diameter_mm=positive(fab["via_diameter_mm"], "diameter"),
        basis="explicit source current and fabrication loss/drop budgets; thermal validation separate",
    )


def reserve_array_space(graph, intents, fab, edge_clearance_mm):
    """Reserve a conservative, rotation-independent courtyard for source arrays.

    The normal envelope includes bus copper, via barrels and board clearance;
    its symmetric courtyard keeps the reservation valid at every cardinal pose.
    """
    for intent in intents:
        if intent['kind'] != 'power_array':
            continue
        comp = graph.component(intent['ref'])
        pads = [p for p in comp.pads if p.name in intent['pads']]
        sizing = size_array(intent, fab)
        n, diameter, drill = sizing['count'], sizing['diameter_mm'], sizing['drill_mm']
        span = (n - 1) * max(diameter + .2, drill + fab.get('hole_clearance_mm', .2))
        if span > intent['max_array_span_mm']:
            raise ValueError('current-sized array exceeds source span')
        area = (intent['rms_current_a'] / (.048 * fab['plane_access_delta_t_c'] ** .44)) ** (1/.725)
        width = max(fab.get('power_bus_min_width_mm', .2), area/(1.378*fab['outer_copper_oz'])*.0254)
        xs, ys = [p.offset[0] for p in pads], [p.offset[1] for p in pads]
        normal = 0 if max(xs)-min(xs) < .01 else 1 if max(ys)-min(ys) < .01 else None
        if normal is None:
            raise ValueError('source-pad bank must form a cardinal row')
        envelope = list(comp.courtyard)
        for axis in (0, 1):
            extent = max(abs(p.offset[axis]) + p.size[axis]/2 for p in pads)
            if axis == normal:
                extent += max(diameter+.15, width/2-.25) + edge_clearance_mm
            else:
                center = (max(p.offset[axis] for p in pads)+min(p.offset[axis] for p in pads))/2
                extent = max(extent, abs(center)+span/2+diameter/2) + edge_clearance_mm
            envelope[axis] = max(envelope[axis], 2*extent)
        comp.courtyard = tuple(envelope)


def array_geometry(pads, center, intent, fab, offset_mm=0.0):
    """Shared physical copper plan in either engine or native mm coordinates.

    pads contains (center, axis-aligned copper size) in the caller's frame.
    Reflection/rotation of a cardinal pad row preserves the same physical bank.
    """
    sizing=size_array(intent,fab)
    ps=[point for point,size in pads]
    cx=sum(p[0] for p in ps)/len(ps);cy=sum(p[1] for p in ps)/len(ps)
    if max(p[0] for p in ps)-min(p[0] for p in ps)<.01:
        ux,uy=math.copysign(1,cx-center[0]),0
    elif max(p[1] for p in ps)-min(p[1] for p in ps)<.01:
        ux,uy=0,math.copysign(1,cy-center[1])
    else:raise ValueError('source-pad bank must form a cardinal row')
    vx,vy=-uy,ux
    projections=[x*vx+y*vy for x,y in ps];low,high=min(projections),max(projections)
    n=sizing['count'];diameter=sizing['diameter_mm'];drill=sizing['drill_mm']
    pitch=max(diameter+.2,drill+fab.get('hole_clearance_mm',.2));span=(n-1)*pitch
    if span>intent['max_array_span_mm']:raise ValueError('current-sized array exceeds source span')
    edge=max(x*ux+y*uy+(size[0]*abs(ux)+size[1]*abs(uy))/2 for (x,y),size in pads)
    bus=edge-.25;via_axis=edge+diameter/2+.15+offset_mm
    midpoint=(low+high)/2
    positions=[midpoint+(i-(n-1)/2)*span/max(1,n-1) for i in range(n)]
    def width(current):
        area=(current/(.048*fab['plane_access_delta_t_c']**.44))**(1/.725)
        return area/(1.378*fab['outer_copper_oz'])*.0254
    bus_width=max(fab.get('power_bus_min_width_mm',.2),width(intent['rms_current_a']))
    feed_width=max(fab['track_width_mm'],width(intent['rms_current_a']/n))
    def point(a,z):return (a*ux+z*vx,a*uy+z*vy)
    tracks=[(point(bus,min(low,min(positions))),point(bus,max(high,max(positions))),bus_width)]
    tracks += [(p,point(bus,z),max(feed_width,min(size))) for (p,size),z in zip(pads,projections)]
    tracks += [(point(bus,z),point(via_axis,z),feed_width) for z in positions]
    return dict(sizing=sizing,bus_width_mm=bus_width,feed_width_mm=feed_width,span_mm=span,
                tracks=[t for t in tracks if math.dist(t[0],t[1])>1e-8],
                vias=[(point(via_axis,z),diameter,drill) for z in positions])
