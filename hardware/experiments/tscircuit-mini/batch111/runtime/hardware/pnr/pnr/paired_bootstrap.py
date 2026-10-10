"""Route source-declared pairs before ordinary signals claim their corridors.

Controller uses the PnR interpreter; each exact geometry/DRC transaction runs
in a fresh KiCad process. Only legal intermediate-package proposals are tried.
An unsuccessful pair remains explicitly pending for the final completeness gate.
"""
import argparse,json,os,subprocess,time
from pathlib import Path
from pnr.native_loop import copy_board,pair_placements
from pnr.placement_trials import diverse_pair_poses


def run(board,rules,constraints,out,kicad_python,kicad_cli,seconds=600,attempts=5,search_seconds=90,allow_placement=True):
    out=Path(out);out.mkdir(parents=True,exist_ok=False)
    board=Path(board).resolve();rules=Path(rules).resolve()
    current=out/'baseline.kicad_pcb';copy_board(board,current)
    # Workers share precisely this isolated source tree, never a live checkout.
    env=dict(os.environ,PYTHONPATH=str(Path(__file__).resolve().parent.parent))
    started=time.monotonic();events=[]
    policy=json.loads(rules.read_text());references=list(policy.get('routed_pair_references',[]))
    rules=out/'rules.json';rules.write_text(json.dumps(policy,indent=2))
    def invoke(args,log):
        with log.open('w') as f:subprocess.run(args,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
    policy=json.loads(rules.read_text())
    for pi,pair in enumerate(policy.get('diff_pairs',[])):
        if time.monotonic()-started>=seconds:break
        folder=out/f'pair-{pi:02}';folder.mkdir()
        inv=folder/'inventory.json'
        invoke([kicad_python,'-m','pnr.native_loop',str(current),'--worker','inspect','--rules',str(rules),'--report',str(inv)],folder/'inventory.log')
        inventory=json.loads(inv.read_text())
        jobs=[t for t in inventory['targets'] if t['net'] in (pair['p'],pair['n'])]
        if not jobs:
            events.append(dict(pair=pair['name'],status='already_connected'));continue
        target=jobs[0]
        base=[kicad_python,'-m','pnr.native_electrical',str(current),'--rules',str(rules),'--net',target['net'],'--source-pad',target['source'],'--target-pad',target['target'],'--bounds',*map(str,inventory['bounds']),'--kicad-cli',kicad_cli]
        proposals=pair_placements(inventory,constraints,pair) if allow_placement else []
        pp=folder/'proposals.json';pp.write_text(json.dumps(proposals,indent=2))
        if proposals:
            screen=folder/'screen'
            invoke(base+['--out-dir',str(screen),'--placement-candidates',str(pp)],folder/'screen.log')
            proposals=json.loads((screen/'result.json').read_text())['proposals']
        for ti,proposal in enumerate([None]+diverse_pair_poses(proposals,attempts-1)):
            remaining=seconds-(time.monotonic()-started)
            if remaining<=0:break
            trial=folder/f'trial-{ti:02}'
            cmd=base+['--out-dir',str(trial),'--seconds',str(min(search_seconds,remaining))]
            if proposal is not None:
                spec=folder/f'pose-{ti:02}.json';spec.write_text(json.dumps(proposal));cmd+=['--placement-spec',str(spec)]
            invoke(cmd,folder/f'trial-{ti:02}.log')
            result=json.loads((trial/'result.json').read_text())
            events.append(dict(pair=pair['name'],trial=ti,proposal=proposal,status=result['status'],accepted=result.get('accepted',False),folder=str(trial)))
            (out/'progress.json').write_text(json.dumps(dict(events=events,seconds=time.monotonic()-started),indent=2))
            if result.get('accepted'):
                current=trial/'candidate.kicad_pcb'
                references=[ref for ref in references if ref['pair']!=pair['name']]
                references.append(dict(pair=pair['name'],segments=result['segments']))
                policy['routed_pair_references']=references;rules.write_text(json.dumps(policy,indent=2))
                break
    final=out/'candidate.kicad_pcb';copy_board(current,final)
    (out/'paired-reference.json').write_text(json.dumps(references,indent=2))
    (out/'result.json').write_text(json.dumps(dict(events=events,seconds=time.monotonic()-started,board=str(final)),indent=2))
    return final


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('board');p.add_argument('--rules',required=True);p.add_argument('--constraints',required=True);p.add_argument('--out-dir',required=True);p.add_argument('--kicad-python',required=True);p.add_argument('--kicad-cli',required=True);p.add_argument('--seconds',type=float,default=600);p.add_argument('--attempts',type=int,default=5)
    a=p.parse_args();run(a.board,a.rules,a.constraints,a.out_dir,a.kicad_python,a.kicad_cli,a.seconds,a.attempts)

if __name__=='__main__':main()
