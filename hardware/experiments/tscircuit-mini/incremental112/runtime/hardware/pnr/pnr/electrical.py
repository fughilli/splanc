"""Source-derived electrical routing policy. No KiCad or YAML dependency.

IPC-2221 is an explicit screening model, not an IPC-2152 thermal sign-off.
Widths are lower bounds; explicit class widths never override a larger computed
requirement. Inner and outer copper are independently sized. Unknown current
is reported, never inferred from the width of an old trace.
"""
import hashlib
import json
import math
from pathlib import Path
from pnr.plane_intent import positive, size_array


def current_width(current_a, copper_oz, delta_t_c, external=True):
    current_a=positive(current_a,'current_a')
    copper_oz=positive(copper_oz,'copper_oz')
    delta_t_c=positive(delta_t_c,'delta_t_c')
    k=.048 if external else .024
    return (current_a/(k*delta_t_c**.44))**(1/.725)/(1.378*copper_oz)*.0254


def annotations(paths):
    out=[]
    for path in paths:
        path=Path(path);raw=path.read_bytes()
        for line,text in enumerate(raw.decode().splitlines(),1):
            if text.strip().startswith('# @pnr-current '):
                a=json.loads(text.strip().split('# @pnr-current ',1)[1])
                if a.get('scope','net') not in ('net','terminal'):raise ValueError('invalid current scope')
                if not a.get('target') or not a.get('pads'):raise ValueError('current target/pads required')
                positive(a.get('rms_current_a'),'rms_current_a')
                positive(a.get('peak_current_a'),'peak_current_a')
                if a['peak_current_a']<a['rms_current_a']:raise ValueError('peak below RMS')
                a['source']=dict(path=str(path),line=line,sha256=hashlib.sha256(raw).hexdigest())
                out.append(a)
    return out


def resolve_currents(records, components):
    """Resolve stable instance addresses + pin numbers, never ref-based guesses."""
    out=[]
    for a in records:
        target=a['target'].strip('.')
        matches=[c for c in components if c.address.removesuffix('._p')==target or c.address.removesuffix('._p').endswith('.'+target)]
        if len(matches)!=1:raise ValueError('ambiguous/missing current target '+target)
        c=matches[0];pads=[p for p in c.pads if p.name in a['pads']]
        if set(p.name for p in pads)!=set(a['pads']) or len(set(p.net for p in pads))!=1 or not pads[0].net:
            raise ValueError('current pins missing or span multiple nets '+target)
        out.append(dict(a,ref=c.ref,net=pads[0].net))
    return out


def compile_policy(rules, currents, fab):
    """Carry provenance and electrical budgets through the native JSON seam."""
    result=json.loads(json.dumps(rules));result['electrical_fab']=dict(fab)
    result['current_intents']=currents
    policies={}
    for a in currents:
        if a.get('scope','net')!='net':continue
        p=policies.setdefault(a['net'],dict(rms_current_a=0,peak_current_a=0,sources=[]))
        # Multiple declarations describe envelopes of the same net, not loads
        # to sum. Branch load aggregation must happen in source design intent.
        p['rms_current_a']=max(p['rms_current_a'],a['rms_current_a'])
        p['peak_current_a']=max(p['peak_current_a'],a['peak_current_a'])
        p['sources'].append(a['source'])
    for net,p in policies.items():
        base=max([result.get('fab',{}).get('track_width_mm',.2)]+[c['width_mm'] for c in result.get('net_classes',[]) if net in c['nets'] and c.get('width_mm')])
        p['outer_width_mm']=max(base,current_width(p['rms_current_a'],fab['outer_copper_oz'],fab['delta_t_c'],True))
        p['inner_width_mm']=max(base,current_width(p['rms_current_a'],fab['inner_copper_oz'],fab['delta_t_c'],False))
        p['via_array']=size_array(p,fab)
        p['model']='IPC-2221 screening; explicit current envelope; thermal qualification separate'
    result['electrical_nets']=policies
    return result


def net_policy(net,rules):
    p=dict(rules.get('electrical_nets',{}).get(net,{}))
    classes=[c for c in rules.get('net_classes',[]) if net in c.get('nets',[])]
    width=max([rules.get('fab',{}).get('track_width_mm',.2)]+[c['width_mm'] for c in classes if c.get('width_mm')])
    p.setdefault('outer_width_mm',width);p.setdefault('inner_width_mm',width)
    p['plane']=next((c['plane_layer'] for c in classes if c.get('plane_layer')),None)
    p['clearance_mm']=max([rules.get('fab',{}).get('clearance_mm',.15)]+[c['clearance_mm'] for c in classes if c.get('clearance_mm')])
    p['current_known']='rms_current_a' in p
    p['mode']='plane' if p['plane'] else ('power' if width>rules.get('fab',{}).get('track_width_mm',.2) or p['current_known'] else 'signal')
    for pair in rules.get('diff_pairs',[]):
        if net in (pair['p'],pair['n']):p.update(mode='pair',pair=pair)
    return p


def resolve_pair_chains(rules, paths, components):
    """Pair terminal topology is source-authored by instance address and pin."""
    result=json.loads(json.dumps(rules))
    for path in paths:
        raw=Path(path).read_bytes()
        for line,text in enumerate(raw.decode().splitlines(),1):
            if not text.strip().startswith('# @pnr-pair '):continue
            a=json.loads(text.strip().split('# @pnr-pair ',1)[1])
            pair=next(p for p in result['diff_pairs'] if p['name']==a['name'])
            def endpoint(spec):
                out={}
                for polarity in ('p','n'):
                    target,num=spec[polarity].rsplit(':',1)
                    cs=[c for c in components if c.address.removesuffix('._p')==target or c.address.removesuffix('._p').endswith('.'+target)]
                    if len(cs)!=1:raise ValueError('ambiguous pair target '+target)
                    ps=[p for p in cs[0].pads if p.name==num]
                    if len(ps)!=1 or ps[0].net!=pair[polarity]:raise ValueError('pair pin/net mismatch')
                    out[polarity]=cs[0].ref+'.'+num
                return out
            pair['terminal_chain']=[endpoint(t) for t in a['terminal_chain']]
            pair['auxiliary_pairs']=[dict(source=endpoint(t['source']),target=endpoint(t['target']),max_length_mm=positive(t['max_length_mm'],'auxiliary max length')) for t in a.get('auxiliary_pairs',[])]
            pair['max_uncoupled_mm']=positive(a['max_uncoupled_mm'],'max_uncoupled_mm')
            pair['reference_layer']=a['reference_layer']
            pair['source']=dict(path=str(path),line=line,sha256=hashlib.sha256(raw).hexdigest())
    return result


def terminal_policy(ref, pad_numbers, net, rules):
    """A leaf's load budget may differ from the shared rail trunk budget.

    Only fully annotated isolated terminal groups qualify. Distribute no current
    implicitly among parallel pads; summing declared terminal budgets is safe.
    """
    numbers=set(pad_numbers);covered=set();records=[]
    for a in rules.get('current_intents',[]):
        if a.get('scope')=='terminal' and a['ref']==ref and a['net']==net and set(a['pads']) & numbers:
            matched = set(a['pads']) & numbers
            if covered & matched:raise ValueError('overlapping terminal current contracts')
            # A subset receives the entire declared group budget. Never infer
            # equal current sharing merely because an annotation names N pads.
            covered.update(matched);records.append(a)
    if covered!=numbers:return None
    p=net_policy(net,rules);fab=rules['electrical_fab']
    p.update(rms_current_a=sum(a['rms_current_a'] for a in records),peak_current_a=sum(a['peak_current_a'] for a in records),current_known=True,terminal_sources=records)
    floor=rules.get('fab',{}).get('track_width_mm',.2)
    p['outer_width_mm']=max(floor,current_width(p['rms_current_a'],fab['outer_copper_oz'],fab['delta_t_c']))
    p['inner_width_mm']=max(floor,current_width(p['rms_current_a'],fab['inner_copper_oz'],fab['delta_t_c'],False))
    p['via_array']=size_array(p,fab)
    return p


def neck_budget(policy, width, length_mm, fab):
    records=policy.get('terminal_sources',[])
    if len(records)!=1 or length_mm>records[0].get('neck_max_length_mm',0)+1e-6 or length_mm<=0:return None
    thickness=positive(fab['outer_copper_oz'],'outer copper')*1.378*.0254
    resistance=positive(fab['copper_resistivity_ohm_mm'],'resistivity')*length_mm/(positive(width,'neck width')*thickness)
    loss=policy['rms_current_a']**2*resistance;drop=policy['peak_current_a']*resistance
    if loss>positive(fab['neck_loss_budget_w'],'neck loss') or drop>positive(fab['neck_peak_drop_v'],'neck drop'):return None
    return dict(length_mm=length_mm,width_mm=width,resistance_ohm=resistance,loss_w=loss,peak_drop_v=drop,basis='source-bounded short neck; resistive loss/drop screen, thermal qualification separate')
