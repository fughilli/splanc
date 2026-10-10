"""Immutable existing copper reservations in the graph's millimetre frame.

These are obstacles only: they do not assert that any net is complete. Native
connectivity remains authoritative. Layer-specific tracks reserve only that
layer, while through-vias reserve the entire stack including drill spacing.
"""
import math
from pnr.writeback import _segment_distance_sq


def reserve_fixed_copper(grid, copper, route_width=None):
    if copper.get('frame') != 'engine-mm-y-up':
        raise ValueError('fixed copper requires explicit engine frame')
    # Every cell intersecting the forbidden capsule is blocked. The half-cell
    # diagonal covers continuous grid steps as well as their endpoint centres.
    cell_radius=grid.pitch / math.sqrt(2)
    track_radius=(grid.track_width if route_width is None else route_width) / 2
    def reserve(layer,a,b,radius,table):
        grow=radius+cell_radius
        imin=max(0,int(math.floor((min(a[0],b[0])-grow)/grid.pitch)))
        imax=min(grid.nx-1,int(math.floor((max(a[0],b[0])+grow)/grid.pitch)))
        jmin=max(0,int(math.floor((min(a[1],b[1])-grow)/grid.pitch)))
        jmax=min(grid.ny-1,int(math.floor((max(a[1],b[1])+grow)/grid.pitch)))
        for j in range(jmin,jmax+1):
            for i in range(imin,imax+1):
                c=grid.center_of(i,j)
                if _segment_distance_sq(a,b,c,c) <= grow*grow:
                    table[layer,j,i]=True
    for net,layer,a,b,width in copper.get('tracks',[]):
        if not all(math.isfinite(v) for v in [*a,*b,width]) or width<=0:
            raise ValueError('invalid fixed track geometry')
        if layer not in grid.layers:
            continue  # non-signal layer not traversed by this grid
        la=grid.layers.index(layer)
        reserve(la,a,b,width/2+grid.clearance+track_radius,grid.blocked)
        reserve(la,a,b,width/2+grid.clearance+grid.via_radius,grid.via_blocked)
    for via in copper.get('vias',[]):
        p=via['xy'];diameter=via['diameter_mm'];drill=via['drill_mm']
        if not all(math.isfinite(v) for v in [*p,diameter,drill]) or not 0<drill<diameter:
            raise ValueError('invalid fixed via geometry')
        if via.get('type')!='through':
            raise ValueError('only through fixed vias supported')
        for la in range(grid.nlayers):
            reserve(la,p,p,diameter/2+grid.clearance+track_radius,grid.blocked)
            drill_clear=(drill + 2*grid.via_radius)/2 + grid.clearance
            reserve(la,p,p,max(diameter/2+grid.clearance+grid.via_radius,drill_clear),grid.via_blocked)
