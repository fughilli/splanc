"""Persistent spawn workers: immutable grid, independent net proposals."""
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
_GRID=None

def initialize(grid):
    global _GRID
    _GRID=grid

def solve(job):
    from .maze import _route_one
    from pnr.profile import run
    access,net,occ,history,via_cost,pres_fac,blocked=job
    return run('grid-net:'+net,lambda:_route_one(_GRID,access,net,occ,history,via_cost,pres_fac,blocked=blocked))

class NetPool:
    def __init__(self,grid,workers):
        self.grid=grid;self.workers=workers
        self.pool=ProcessPoolExecutor(max_workers=workers,mp_context=multiprocessing.get_context('spawn'),initializer=initialize,initargs=(grid,))
    def configure(self):
        from pnr.runtime_controls import route_workers
        workers=route_workers('grid-batch')
        if workers!=self.workers:
            self.pool.shutdown(wait=True,cancel_futures=True);self.workers=workers
            self.pool=ProcessPoolExecutor(max_workers=workers,mp_context=multiprocessing.get_context('spawn'),initializer=initialize,initargs=(self.grid,))
        return self.workers
    def batch(self,nets,access,occ,history,via_cost,pres_fac,blocked=None):
        # Snapshot before submission: multiprocessing queues serialize later.
        occupancy=dict(occ);costs=dict(history);obstacles=set(blocked) if blocked is not None else None
        return list(self.pool.map(solve,[(access[n],n,occupancy,costs,via_cost,pres_fac,obstacles) for n in nets]))
    def close(self):self.pool.shutdown(wait=True,cancel_futures=True)
