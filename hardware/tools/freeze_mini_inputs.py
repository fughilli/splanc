#!/usr/bin/env python3
"""Freeze repository-controlled Mini PnR inputs before a full production run.

Does not invoke Bazel, edit design inputs, or substitute for its action cache.
The destination must not exist. Compare with --verify after the run; also retain
Bazel logs, native tool versions and archived generated source/stage artifacts.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shutil


def inputs(root):
    paths=set()
    for folder in ('hardware/pnr','hardware/splanc_dev/elec','hardware/atopile'):
        paths.update(p for p in (root/folder).rglob('*') if p.is_file()
                     and '__pycache__' not in p.parts and p.suffix not in ('.pyc','.pyo'))
    for pattern in ('hardware/splanc_dev/*.json','hardware/splanc_dev/*.yaml',
                    'hardware/splanc_dev/BUILD.bazel','patches/rules_atopile*'):
        paths.update(p for p in root.glob(pattern) if p.is_file())
    for name in ('MODULE.bazel','MODULE.bazel.lock','.bazelrc',
                 'hardware/tools/keyhole_region.py','hardware/tools/freeze_mini_inputs.py'):
        p=root/name
        if p.is_file():paths.add(p)
    return sorted(paths)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--verify',action='store_true')
    a=parser.parse_args();root=a.repo.resolve();out=a.directory.resolve()
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    if a.verify:
        expected=json.loads((out/'hashes.json').read_text())
        changed=[name for name,h in expected.items() if not (root/name).is_file() or sha(root/name)!=h]
        frozen_changed=[name for name,h in expected.items() if not (out/name).is_file() or sha(out/name)!=h]
        new_inputs=sorted({str(p.relative_to(root)) for p in inputs(root)}-set(expected))
        result=dict(changed_inputs=changed,changed_snapshot_files=frozen_changed,new_inputs=new_inputs)
        (out/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result));return int(bool(changed or frozen_changed or new_inputs))
    files=inputs(root)
    if any(out==p or out in p.parents for p in files):raise SystemExit('Snapshot destination overlaps input files')
    out.mkdir(parents=True,exist_ok=False);hashes={}
    for p in files:
        name=str(p.relative_to(root));dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(p,dest);hashes[name]=sha(dest)
        if sha(p)!=hashes[name]:raise SystemExit('Input changed during snapshot: '+name)
    (out/'hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
    (out/'metadata.json').write_text(json.dumps(dict(repo=str(root),captured_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),input_count=len(hashes),scope='Repository-controlled Mini design, atomic parts, PnR source, local atopile definitions and fabrication/build configuration. Tool installations and generated stages are archived separately.'),indent=2)+'\n')
    print(f'Frozen {len(hashes)} inputs in {out}')
    return 0

if __name__=='__main__':raise SystemExit(main())
