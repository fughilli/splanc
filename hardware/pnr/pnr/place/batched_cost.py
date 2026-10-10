"""Batched versions of existing placement proxies; never legality/DRC gates.

GPU is explicitly selected by benchmark callers. Production opt-ins use CPU;
small Mini workloads must not silently pay MPS transfer/dispatch overhead.
"""
import math
import numpy as np
import torch


class PaddedWirelength:
    """Same smooth HPWL objective as model.py, one batched reduction.

    Inputs may be (pins, 2) or (candidates, pins, 2). Padding contributes -inf
    to logsumexp; the four signed coordinates reproduce x,-x,y,-y exactly.
    Reduction order changes floating rounding, not the mathematical objective.
    """
    def __init__(self, nets, *, device="cpu"):
        nets = [tuple(int(i) for i in net) for net in nets if len(net) >= 2]
        self.count = len(nets)
        if any(i < 0 for net in nets for i in net):
            raise ValueError("pin indices must be nonnegative")
        width = max(map(len, nets), default=1)
        index = np.zeros((len(nets), width), dtype=np.int64)
        mask = np.zeros_like(index, dtype=bool)
        for j, net in enumerate(nets):
            index[j, :len(net)] = net
            mask[j, :len(net)] = True
        self.index = torch.as_tensor(index, device=device)
        self.mask = torch.as_tensor(mask, device=device)

    def __call__(self, pin_xy, gamma=1.):
        if not math.isfinite(gamma) or gamma <= 0:
            raise ValueError("gamma must be positive")
        single = pin_xy.ndim == 2
        if single:
            pin_xy = pin_xy.unsqueeze(0)
        if pin_xy.ndim != 3 or pin_xy.shape[-1] != 2:
            raise ValueError("expected (..., pins, 2)")
        if not self.count:
            result = pin_xy.sum(dim=(1, 2)) * 0
        else:
            xy = pin_xy[:, self.index, :] / gamma
            signed = torch.cat((xy, -xy), dim=-1)
            signed = signed.masked_fill(~self.mask[None, :, :, None], -float("inf"))
            result = gamma * torch.logsumexp(signed, dim=2).sum(dim=(1, 2))
        return result[0] if single else result


def endpoint_arrays(graph, component):
    """Prepare the existing nearest-peer Manhattan candidate objective."""
    from .geometry import pin_positions
    terminals = {}
    for other in graph.components:
        if other.ref == component.ref:
            continue
        for pad, (_, xy) in zip(other.pads, pin_positions(other)):
            terminals.setdefault(pad.net, []).append(xy)
    rows = [(xy, terminals[pad.net]) for pad, (_, xy) in
            zip(component.pads, pin_positions(component)) if terminals.get(pad.net)]
    width = max((len(peers) for _, peers in rows), default=1)
    offsets = np.zeros((len(rows), 2), dtype=np.float64)
    peers = np.zeros((len(rows), width, 2), dtype=np.float64)
    valid = np.zeros((len(rows), width), dtype=bool)
    for i, (xy, row) in enumerate(rows):
        offsets[i] = np.asarray(xy) - np.asarray(component.pos)
        peers[i, :len(row)] = row
        valid[i, :len(row)] = True
    return offsets, peers, valid


def endpoint_cost_numpy(positions, arrays, *, chunk=128):
    """Bounded-memory float64 scores, including empty nets and duplicate pads."""
    positions = np.asarray(positions, dtype=np.float64).reshape(-1, 2)
    offsets, peers, valid = arrays
    if chunk < 1:
        raise ValueError("chunk must be positive")
    result = np.zeros(len(positions), dtype=np.float64)
    if not len(offsets):
        return result
    for start in range(0, len(positions), chunk):
        delta = positions[start:start+chunk, None, None, :] + offsets[None, :, None, :] - peers[None, :, :, :]
        distances = np.abs(delta).sum(axis=-1)
        distances[:, ~valid] = np.inf
        result[start:start+chunk] = distances.min(axis=2).sum(axis=1)
    return result


class TorchEndpointCost:
    """Experimental resident CPU/MPS equivalent; callers own synchronization."""
    def __init__(self, arrays, *, device="cpu"):
        offsets, peers, valid = arrays
        self.offsets = torch.as_tensor(offsets, dtype=torch.float32, device=device)
        self.peers = torch.as_tensor(peers, dtype=torch.float32, device=device)
        self.valid = torch.as_tensor(valid, device=device)

    def __call__(self, positions, *, chunk=128):
        if chunk < 1:
            raise ValueError("chunk must be positive")
        if not len(self.offsets):
            return positions.sum(dim=1) * 0
        pieces = []
        for start in range(0, len(positions), chunk):
            delta = positions[start:start+chunk, None, None, :] + self.offsets[None, :, None, :] - self.peers[None, :, :, :]
            distance = delta.abs().sum(-1).masked_fill(~self.valid[None, :, :], float("inf"))
            pieces.append(distance.min(dim=2).values.sum(dim=1))
        return torch.cat(pieces) if pieces else positions.new_zeros((0,))


class BucketedWirelength:
    """Smooth HPWL with degree buckets limiting padded pin storage below 2x."""
    def __init__(self,nets,*,device='cpu'):
        groups={}
        for net in nets:
            net=tuple(int(i) for i in net)
            if len(net)<2:continue
            if any(i<0 for i in net):raise ValueError('pin indices must be nonnegative')
            groups.setdefault(1 << (len(net)-1).bit_length(),[]).append(net)
        self.buckets=[PaddedWirelength(groups[k],device=device) for k in sorted(groups)]
        self.actual_entries=sum(len(n) for group in groups.values() for n in group)
        self.padded_entries=sum(len(group)*max(map(len,group)) for group in groups.values())
        self.bucket_count=len(self.buckets)
    def __call__(self,pin_xy,gamma=1.):
        if not math.isfinite(gamma) or gamma<=0:raise ValueError('gamma must be positive and finite')
        if pin_xy.ndim not in (2,3) or pin_xy.shape[-1]!=2:raise ValueError('expected (..., pins, 2)')
        if not self.buckets:return pin_xy.sum(dim=(-2,-1))*0
        return torch.stack([bucket(pin_xy,gamma) for bucket in self.buckets],dim=0).sum(dim=0)
