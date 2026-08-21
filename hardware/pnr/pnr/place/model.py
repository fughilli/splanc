"""Differentiable global placement (design doc §4/§8).

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
removes the residual overlaps. No orientation search yet (Phase 3).
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import torch
from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from .geometry import courtyard_rect, keepout_rects, resolve_fixed_poses


def _half_sizes(graph: BoardGraph) -> torch.Tensor:
    hs = [(courtyard_rect(c).w / 2.0, courtyard_rect(c).h / 2.0) for c in graph.components]
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
    w_spread: float = 1.0,
    w_bound: float = 20.0,
    w_keep: float = 40.0,
    w_group: float = 0.5,
) -> Dict[str, Tuple[float, float]]:
    """Optimize continuous component centres; return ``{ref: (x, y)}`` for all."""
    torch.manual_seed(seed)
    comps = graph.components
    n = len(comps)
    idx = {c.ref: i for i, c in enumerate(comps)}

    half = _half_sizes(graph)  # (n, 2)

    poses = resolve_fixed_poses(graph, constraints)
    is_fixed = torch.zeros(n, dtype=torch.bool)
    fixed_xy = torch.zeros(n, 2, dtype=torch.float32)
    for ref, (px, py) in poses.items():
        if ref in idx:
            is_fixed[idx[ref]] = True
            fixed_xy[idx[ref]] = torch.tensor([px, py])

    # Init movable parts spread across the interior (seeded, deterministic).
    init = torch.rand(n, 2)
    init[:, 0] = half[:, 0] + init[:, 0] * (width - 2 * half[:, 0])
    init[:, 1] = half[:, 1] + init[:, 1] * (height - 2 * half[:, 1])
    move = torch.nn.Parameter(init.clone())

    def full_pos() -> torch.Tensor:
        return torch.where(is_fixed.unsqueeze(1), fixed_xy, move)

    # Pins: (component index, rotated offset) — offset constant (rot is fixed).
    pin_comp: List[int] = []
    pin_off: List[Tuple[float, float]] = []
    pin_key: Dict[Tuple[str, str], int] = {}
    for c in comps:
        th = torch.deg2rad(torch.tensor(c.rot))
        ct, st = float(torch.cos(th)), float(torch.sin(th))
        for pad in c.pads:
            ox, oy = pad.offset
            pin_key[(c.ref, pad.name)] = len(pin_comp)
            pin_comp.append(idx[c.ref])
            pin_off.append((ox * ct - oy * st, ox * st + oy * ct))
    pin_comp_t = torch.tensor(pin_comp, dtype=torch.long)
    pin_off_t = torch.tensor(pin_off, dtype=torch.float32)
    net_pin_idx = [[pin_key[p] for p in net.pins if p in pin_key] for net in graph.nets]
    net_pin_idx = [pins for pins in net_pin_idx if len(pins) >= 2]

    # Edge-align targets (soft): (comp_idx, axis, target_coord, weight).
    edge_terms: List[Tuple[int, int, float, float]] = []
    for con in constraints.constraints:
        if con.kind != "edge_align":
            continue
        edge = con.params.get("edge")
        for ref in con.refs:
            if ref not in idx:
                continue
            i = idx[ref]
            hw, hh = float(half[i, 0]), float(half[i, 1])
            if edge == "south":
                edge_terms.append((i, 1, hh, con.weight or 1.0))
            elif edge == "north":
                edge_terms.append((i, 1, height - hh, con.weight or 1.0))
            elif edge == "west":
                edge_terms.append((i, 0, hw, con.weight or 1.0))
            elif edge == "east":
                edge_terms.append((i, 0, width - hw, con.weight or 1.0))

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

    movable_mask = ~is_fixed
    clearance = float(constraints.board.default_clearance_mm)

    opt = torch.optim.Adam([move], lr=lr)
    for _ in range(iters):
        opt.zero_grad()
        pos = full_pos()
        pin_x = pos[pin_comp_t, 0] + pin_off_t[:, 0]
        pin_y = pos[pin_comp_t, 1] + pin_off_t[:, 1]

        wl = pos.new_zeros(())
        for pins in net_pin_idx:
            px = pin_x[pins]
            py = pin_y[pins]
            wl = wl + gamma * (
                torch.logsumexp(px / gamma, 0)
                + torch.logsumexp(-px / gamma, 0)
                + torch.logsumexp(py / gamma, 0)
                + torch.logsumexp(-py / gamma, 0)
            )

        # Pairwise smooth overlap (spreading). Upper triangle only.
        dx = (pos[:, 0].unsqueeze(1) - pos[:, 0].unsqueeze(0)).abs()
        dy = (pos[:, 1].unsqueeze(1) - pos[:, 1].unsqueeze(0)).abs()
        sw = half[:, 0].unsqueeze(1) + half[:, 0].unsqueeze(0) + clearance
        sh = half[:, 1].unsqueeze(1) + half[:, 1].unsqueeze(0) + clearance
        ox = torch.clamp(sw - dx, min=0.0)
        oy = torch.clamp(sh - dy, min=0.0)
        overlap = torch.triu(ox * oy, diagonal=1).sum()

        # Outline containment.
        cx, cy = pos[:, 0], pos[:, 1]
        bound = (
            torch.clamp(half[:, 0] - cx, min=0.0) ** 2
            + torch.clamp(cx + half[:, 0] - width, min=0.0) ** 2
            + torch.clamp(half[:, 1] - cy, min=0.0) ** 2
            + torch.clamp(cy + half[:, 1] - height, min=0.0) ** 2
        )
        bound = (bound * movable_mask.float()).sum()

        loss = wl + w_spread * overlap + w_bound * bound

        for i, axis, target, weight in edge_terms:
            loss = loss + weight * (pos[i, axis] - target) ** 2

        for members, anchor, radius, weight in group_terms:
            m = torch.tensor(members, dtype=torch.long)
            d = torch.linalg.vector_norm(pos[m] - pos[anchor], dim=1)
            loss = loss + weight * (torch.clamp(d - radius, min=0.0) ** 2).sum()

        if keep_t is not None:
            kdx = (cx.unsqueeze(1) - keep_t[:, 0].unsqueeze(0)).abs()
            kdy = (cy.unsqueeze(1) - keep_t[:, 1].unsqueeze(0)).abs()
            kox = torch.clamp(
                half[:, 0].unsqueeze(1) + keep_t[:, 2].unsqueeze(0) + clearance - kdx,
                min=0.0,
            )
            koy = torch.clamp(
                half[:, 1].unsqueeze(1) + keep_t[:, 3].unsqueeze(0) + clearance - kdy,
                min=0.0,
            )
            keep_pen = ((kox * koy) * movable_mask.float().unsqueeze(1)).sum()
            loss = loss + w_keep * keep_pen

        loss.backward()
        opt.step()

    pos = full_pos().detach()
    return {c.ref: (float(pos[i, 0]), float(pos[i, 1])) for i, c in enumerate(comps)}
