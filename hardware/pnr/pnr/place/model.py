"""Differentiable global placement (design doc §4/§8, orientation §9.3).

Relaxes a continuous placement by gradient descent on a smooth loss:

    L = WL(log-sum-exp HPWL)          # connected pins attract
      + w_spread * overlap            # courtyards repel (spreading)
      + w_bound  * outline_penalty    # stay inside the board
      + w_edge   * edge_align         # soft pull to a board edge
      + w_keep   * keepout_penalty    # keep movable parts out of keep-outs
      + w_group  * grouping           # cluster grouped parts near their anchor

Positions of ``fixed`` parts are held constant (they still anchor the wirelength);
everything else is an optimized parameter. This is the DREAMPlace reframing —
"placement is training a network" — in plain PyTorch on CPU, deterministic under a
fixed seed. It produces good *continuous* positions; :mod:`pnr.place.legalize`
removes the residual overlaps.

**Orientation** (``orient=True``): each movable part also carries a categorical
over the four 90° rotations, relaxed to a softmax whose temperature is annealed
toward one-hot (a deterministic Concrete/Gumbel-Softmax relaxation — Cypress §9.3).
Pin offsets and courtyard extents become the *expected* offset/extent under that
distribution, so orientation is differentiable and co-optimized with position; at
the end we snap to the arg-max angle. Fixed parts keep their constrained angle.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import torch
from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from .geometry import keepout_rects, resolve_fixed_poses

# Reproducibility ("same inputs -> same board", design §10): run torch
# single-threaded so the float reductions don't vary with thread scheduling.
# Set at import, before any parallel work sizes the intra-op pool.
torch.set_num_threads(1)

# The discrete rotation set (degrees) the placer chooses from.
ANGLES = (0.0, 90.0, 180.0, 270.0)


def _base_half_sizes(graph: BoardGraph) -> torch.Tensor:
    """Unrotated courtyard half-(w, h) per component (parts ingest at rot 0)."""
    hs = [(c.courtyard[0] / 2.0, c.courtyard[1] / 2.0) for c in graph.components]
    return torch.tensor(hs, dtype=torch.float32)


def global_place(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    width: float,
    height: float,
    *,
    seed: int = 0,
    iters: int = 800,
    lr: float = 0.3,
    gamma: float = 1.0,
    orient: bool = True,
    w_spread: float = 1.0,
    w_bound: float = 20.0,
    w_keep: float = 40.0,
    w_group: float = 0.5,
) -> Tuple[Dict[str, Tuple[float, float]], Dict[str, float]]:
    """Optimize continuous centres (+ orientation); return positions and angles.

    Returns ``({ref: (x, y)}, {ref: angle_deg})`` for every component (angle is
    the arg-max of the relaxed rotation distribution, a legal 0/90/180/270)."""
    torch.manual_seed(seed)
    comps = graph.components
    n = len(comps)
    idx = {c.ref: i for i, c in enumerate(comps)}

    half = _base_half_sizes(graph)  # (n, 2), unrotated
    # Courtyard half-size per candidate angle: swap w/h at 90/270.
    swapped = half[:, [1, 0]]
    half4 = torch.stack([half, swapped, half, swapped], dim=1)  # (n, 4, 2)

    poses = resolve_fixed_poses(graph, constraints)
    is_fixed = torch.zeros(n, dtype=torch.bool)
    fixed_xy = torch.zeros(n, 2, dtype=torch.float32)
    fixed_angle_idx = torch.zeros(n, dtype=torch.long)
    fixed_rot = {}
    for con in constraints.constraints:
        if con.kind == "fixed":
            for ref in con.refs:
                fixed_rot[ref] = con.params.get("rot") or 0.0
    for ref, (px, py) in poses.items():
        if ref in idx:
            is_fixed[idx[ref]] = True
            fixed_xy[idx[ref]] = torch.tensor([px, py])
            fixed_angle_idx[idx[ref]] = int(round(fixed_rot.get(ref, 0.0) / 90.0)) % 4

    # Init movable positions spread across the interior (seeded, deterministic).
    init = torch.rand(n, 2)
    init[:, 0] = half[:, 0] + init[:, 0] * (width - 2 * half[:, 0])
    init[:, 1] = half[:, 1] + init[:, 1] * (height - 2 * half[:, 1])
    move = torch.nn.Parameter(init.clone())

    params = [move]
    rot_logits = None
    if orient:
        rot_logits = torch.nn.Parameter(torch.zeros(n, 4))
        params.append(rot_logits)
    fixed_onehot = torch.nn.functional.one_hot(fixed_angle_idx, 4).float()

    def full_pos() -> torch.Tensor:
        return torch.where(is_fixed.unsqueeze(1), fixed_xy, move)

    def rot_probs(temp: float) -> torch.Tensor:
        """(n, 4) rotation distribution; fixed parts pinned one-hot."""
        if rot_logits is None:
            raw = torch.zeros(n, 4)
            raw[:, 0] = 1.0
        else:
            raw = torch.softmax(rot_logits / temp, dim=1)
        return torch.where(is_fixed.unsqueeze(1), fixed_onehot, raw)

    # Pins: component index + the four rotated offsets (rot 0/90/180/270).
    pin_comp: List[int] = []
    pin_off4: List[List[Tuple[float, float]]] = []
    pin_key: Dict[Tuple[str, str], int] = {}
    for c in comps:
        for pad in c.pads:
            ox, oy = pad.offset
            pin_key[(c.ref, pad.name)] = len(pin_comp)
            pin_comp.append(idx[c.ref])
            variants = []
            for ang in ANGLES:
                th = torch.deg2rad(torch.tensor(ang))
                ct, st = float(torch.cos(th)), float(torch.sin(th))
                variants.append((ox * ct - oy * st, ox * st + oy * ct))
            pin_off4.append(variants)
    pin_comp_t = torch.tensor(pin_comp, dtype=torch.long)
    pin_off4_t = torch.tensor(pin_off4, dtype=torch.float32)  # (P, 4, 2)
    net_pin_idx = [[pin_key[p] for p in net.pins if p in pin_key] for net in graph.nets]
    net_pin_idx = [pins for pins in net_pin_idx if len(pins) >= 2]

    # Edge-align targets (soft): (comp_idx, axis, edge, weight).
    edge_terms: List[Tuple[int, int, str, float]] = []
    for con in constraints.constraints:
        if con.kind != "edge_align":
            continue
        edge = con.params.get("edge")
        for ref in con.refs:
            if ref in idx:
                axis = 1 if edge in ("south", "north") else 0
                edge_terms.append((idx[ref], axis, edge, con.weight or 1.0))

    # Grouping (soft): pull members within radius of the anchor.
    group_terms: List[Tuple[List[int], int, float, float]] = []
    for con in constraints.constraints:
        if con.kind != "group":
            continue
        anchor = con.params.get("anchor")
        if anchor not in idx:
            continue
        members = [idx[r] for r in con.refs if r in idx and r != anchor]
        if members:
            group_terms.append(
                (members, idx[anchor], float(con.params.get("radius_mm") or 5.0), con.weight or 1.0)
            )

    keepouts = keepout_rects(graph, constraints, poses)
    keep_t = (
        torch.tensor([[k.cx, k.cy, k.w / 2, k.h / 2] for k in keepouts], dtype=torch.float32)
        if keepouts
        else None
    )

    movable_f = (~is_fixed).float()
    clearance = float(constraints.board.default_clearance_mm)
    opt = torch.optim.Adam(params, lr=lr)

    for step in range(iters):
        temp = 2.0 - (2.0 - 0.2) * (step / max(1, iters - 1))  # anneal 2.0 -> 0.2
        opt.zero_grad()
        pos = full_pos()
        p = rot_probs(temp)  # (n, 4)

        # Expected pin offset under the rotation distribution.
        p_pin = p[pin_comp_t]  # (P, 4)
        exp_off = (p_pin.unsqueeze(-1) * pin_off4_t).sum(1)  # (P, 2)
        pin_x = pos[pin_comp_t, 0] + exp_off[:, 0]
        pin_y = pos[pin_comp_t, 1] + exp_off[:, 1]

        wl = pos.new_zeros(())
        for pins in net_pin_idx:
            px, py = pin_x[pins], pin_y[pins]
            wl = wl + gamma * (
                torch.logsumexp(px / gamma, 0)
                + torch.logsumexp(-px / gamma, 0)
                + torch.logsumexp(py / gamma, 0)
                + torch.logsumexp(-py / gamma, 0)
            )

        # Expected courtyard half-size (rotation-aware).
        exp_half = (p.unsqueeze(-1) * half4).sum(1)  # (n, 2)
        hw, hh = exp_half[:, 0], exp_half[:, 1]

        # Pairwise smooth overlap (spreading), upper triangle only.
        dx = (pos[:, 0].unsqueeze(1) - pos[:, 0].unsqueeze(0)).abs()
        dy = (pos[:, 1].unsqueeze(1) - pos[:, 1].unsqueeze(0)).abs()
        sw = hw.unsqueeze(1) + hw.unsqueeze(0) + clearance
        sh = hh.unsqueeze(1) + hh.unsqueeze(0) + clearance
        ox = torch.clamp(sw - dx, min=0.0)
        oy = torch.clamp(sh - dy, min=0.0)
        overlap = torch.triu(ox * oy, diagonal=1).sum()

        # Outline containment.
        cx, cy = pos[:, 0], pos[:, 1]
        bound = (
            torch.clamp(hw - cx, min=0.0) ** 2
            + torch.clamp(cx + hw - width, min=0.0) ** 2
            + torch.clamp(hh - cy, min=0.0) ** 2
            + torch.clamp(cy + hh - height, min=0.0) ** 2
        )
        bound = (bound * movable_f).sum()

        loss = wl + w_spread * overlap + w_bound * bound

        for i, axis, edge, weight in edge_terms:
            extent = hh[i] if axis == 1 else hw[i]
            if edge in ("south", "west"):
                target = extent
            else:  # north / east
                target = (height if axis == 1 else width) - extent
            loss = loss + weight * (pos[i, axis] - target) ** 2

        for members, anchor, radius, weight in group_terms:
            m = torch.tensor(members, dtype=torch.long)
            d = torch.linalg.vector_norm(pos[m] - pos[anchor], dim=1)
            loss = loss + weight * (torch.clamp(d - radius, min=0.0) ** 2).sum()

        if keep_t is not None:
            kdx = (cx.unsqueeze(1) - keep_t[:, 0].unsqueeze(0)).abs()
            kdy = (cy.unsqueeze(1) - keep_t[:, 1].unsqueeze(0)).abs()
            kox = torch.clamp(
                hw.unsqueeze(1) + keep_t[:, 2].unsqueeze(0) + clearance - kdx, min=0.0
            )
            koy = torch.clamp(
                hh.unsqueeze(1) + keep_t[:, 3].unsqueeze(0) + clearance - kdy, min=0.0
            )
            loss = loss + w_keep * ((kox * koy) * movable_f.unsqueeze(1)).sum()

        loss.backward()
        opt.step()

    pos = full_pos().detach()
    p = rot_probs(0.2).detach()
    angle_idx = torch.argmax(p, dim=1)
    positions = {c.ref: (float(pos[i, 0]), float(pos[i, 1])) for i, c in enumerate(comps)}
    rotations = {c.ref: float(ANGLES[int(angle_idx[i])]) for i, c in enumerate(comps)}
    return positions, rotations
