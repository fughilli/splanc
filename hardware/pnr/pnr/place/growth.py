"""Bounded outline-growth proposal for explicitly enabled mechanical experiments."""

def propose_growth(history, current, original, *, enabled=False, window=2,
                   min_improvement=.05, step=1.05, max_scale=1.10):
    if not enabled:return None,'outline_locked'
    if len(history)<window+1:return None,'insufficient_history'
    old=min(history[:-window]);recent=min(history[-window:])
    if recent<=0 or recent<old*(1-min_improvement):return None,'routing_improving'
    scale=min(max_scale,min(current[i]/original[i] for i in (0,1))*step)
    proposal=tuple(original[i]*scale for i in (0,1))
    if all(proposal[i]<=current[i]+1e-9 for i in (0,1)):return None,'outline_cap'
    return proposal,'stalled_global_routing_demand'
