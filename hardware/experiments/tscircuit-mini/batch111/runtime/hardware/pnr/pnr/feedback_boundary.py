"""Return source-owned placement entities from a native electrical inventory."""
import copy

def placement_graph(inventory, source, rules):
    graph=copy.deepcopy(inventory['graph']);authored={c['ref']:c for c in source['components']}
    generated={h['name'] for h in rules.get('mounting_holes',[])}
    extras={c['ref'] for c in graph['components']}-set(authored)
    if extras-generated:raise ValueError('Unexpected native-only placement entities: '+str(sorted(extras-generated)))
    if set(authored)-{c['ref'] for c in graph['components']}:raise ValueError('Native graph lost source components')
    # Mount clearance remains a compiled keepout. Its generated NPTH footprint
    # is not another placeable component and cannot collide with its own region.
    graph['components']=[c for c in graph['components'] if c['ref'] in authored]
    physical=set(inventory.get('physical_locks',[]))
    for c in graph['components']:c['locked']=authored[c['ref']].get('locked',False) or c['ref'] in physical
    graph['nets']=[dict(n,pins=[p for p in n['pins'] if p[0] in authored]) for n in graph['nets']]
    return graph
