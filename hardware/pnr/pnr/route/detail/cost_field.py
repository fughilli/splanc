"""Exact max-neighbour prices; invocation-local and independent of DRC predicates."""
import numpy as np

def neighbourhood_max(values, radius):
    # Separable square maximum with clipped edges, never periodic wraparound.
    out = values
    for axis in (-1, -2):
        source = out
        out = source.copy()
        for distance in range(1, min(radius, source.shape[axis] - 1) + 1):
            low = [slice(None)] * source.ndim
            high = list(low)
            low[axis] = slice(None, -distance)
            high[axis] = slice(distance, None)
            np.maximum(out[tuple(low)], source[tuple(high)], out=out[tuple(low)])
            np.maximum(out[tuple(high)], source[tuple(low)], out=out[tuple(high)])
    return out

def prices(nx, ny, nlayers, counts, history, penalties, track_halo, via_halo, present):
    shape = (nlayers, ny, nx)
    arrays = []
    for mapping in (counts, history, penalties):
        value = np.zeros(shape, dtype=np.float64)
        flat = value.reshape(-1)
        for key, price in mapping.items():
            if 0 <= key < flat.size:
                flat[key] = price
        arrays.append(value)
    # Occupancy always includes zero in its max; history/soft prices do not.
    np.maximum(arrays[0], 0., out=arrays[0])
    ordinary = [neighbourhood_max(a, track_halo) for a in arrays]
    via = [neighbourhood_max(a.max(axis=0), max(track_halo, via_halo)) for a in arrays]
    def combine(a):
        # Same arithmetic grouping as the sparse scalar code.
        return ((1.0 + a[1]) * (1.0 + present * a[0]) + a[2]).reshape(-1)
    return combine(ordinary), combine(via)
