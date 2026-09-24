"""Protect already routed pair reference corridors during via search."""
class ReferenceGuard:
    def __init__(self,board,rules):
        import pcbnew as k
        from pnr.electrical import net_policy
        from pnr.native_electrical import vec
        self.rules=rules;self.rows=[]
        pairs={p['name']:p for p in rules.get('diff_pairs',[])}
        present={t.GetNetname() for t in board.GetTracks()}
        for witness in rules.get('routed_pair_references',[]):
            pair=pairs[witness['pair']]
            if not {pair['p'],pair['n']}<=present:continue
            layer=pair.get('reference_layer','In1.Cu')
            nets={n for c in rules.get('net_classes',[]) if c.get('plane_layer')==layer for n in c['nets']}
            zones=[z for z in board.Zones() if not z.GetIsRuleArea() and z.IsOnLayer(board.GetLayerID(layer)) and z.GetNetname() in nets]
            clearance=max([float(z.GetLocalClearance())/1e6 for z in zones]+[rules.get('fab',{}).get('clearance_mm',.2)]+[net_policy(n,rules)['clearance_mm'] for n in nets])
            for segment in witness['segments']:
                for path in segment['reference_paths'].values():
                    for a,z in zip(path,path[1:]):
                        track=k.PCB_TRACK(board);track.SetLayer(k.F_Cu);track.SetStart(vec(a));track.SetEnd(vec(z));track.SetWidth(round((pair['width_mm']+pair['gap_mm'])*1e6))
                        self.rows.append((track.GetEffectiveShape(k.F_Cu),nets,clearance))
    def via_clear(self,net,point,diameter):
        import pcbnew as k
        from pnr.electrical import net_policy
        from pnr.native_electrical import vec
        gap=net_policy(net,self.rules)['clearance_mm']
        for corridor,nets,clearance in self.rows:
            if net in nets:continue
            aperture=k.SHAPE_CIRCLE(vec(point),round((diameter/2+max(gap,clearance)+.004)*1e6))
            if corridor.Collide(aperture,0):return False
        return True
