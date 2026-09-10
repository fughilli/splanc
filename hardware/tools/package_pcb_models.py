"""Make an engineering CAD review copy with self-contained, checked 3D assets.

Run with KiCad Python. Uses each source footprint's current model declarations,
so old generated PCB references to missing build caches do not silently hide
components. Does not change circuit or routing geometry, or certify release.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path


def circuit_signature(board):
    return sorted((fp.m_Uuid.AsString(), fp.GetReference(), p.m_Uuid.AsString(),
                   p.GetNumber(), p.GetNetname(), p.GetPosition().x, p.GetPosition().y,
                   p.GetSize().x, p.GetSize().y)
                  for fp in board.GetFootprints() for p in fp.Pads())


def package(pcb, parts, source_project, output):
    import pcbnew
    pcb, parts, source_project, output = map(Path, (pcb, parts, source_project, output))
    if pcb.resolve() == output.resolve():
        raise ValueError('The review copy must not overwrite the source PCB')
    board = pcbnew.LoadBoard(str(pcb))
    before = circuit_signature(board)
    records, changes, errors = [], [], []
    for fp in board.GetFootprints():
        if fp.GetValue() == 'PNR mounting hole':
            continue  # A drilled hole has no populated 3D component.
        library, item = fp.GetFPIDAsString().split(':', 1)
        source_fp = parts / library / (item + '.kicad_mod')
        if not source_fp.is_file():
            errors.append(f'{fp.GetReference()}: missing source footprint {source_fp}')
            continue
        model_fp = pcbnew.FootprintLoad(str(source_fp.parent), item)
        model_changes = []
        if not len(model_fp.Models()):
            errors.append(f'{fp.GetReference()}: no model declaration')
        for source_model in model_fp.Models():
            path = Path(source_model.m_Filename.replace('${KIPRJMOD}', str(source_project.resolve())))
            if not path.is_file():
                errors.append(f'{fp.GetReference()}: missing model {path}')
                continue
            relative = Path('models') / library / path.name
            model = pcbnew.FP_3DMODEL()
            for attr in ('m_Scale', 'm_Rotation', 'm_Offset', 'm_Opacity', 'm_Show'):
                setattr(model, attr, getattr(source_model, attr))
            model.m_Filename = '${KIPRJMOD}/' + relative.as_posix()
            model_changes.append((model, path, relative, source_fp.parent))
            records.append({'reference': fp.GetReference(), 'library': library,
                            'model': relative.as_posix(),
                            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        changes.append((fp, model_changes))
    if errors:
        raise ValueError('\n'.join(errors))
    output.parent.mkdir(parents=True, exist_ok=True)
    for fp, models in changes:
        fp.Models().clear()
        for model, source, relative, source_dir in models:
            dest = output.parent / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            for note in source_dir.glob('*NOTES.md'):
                shutil.copyfile(note, dest.parent / note.name)
            for license_file in source_dir.glob('*LICENSE*'):
                if license_file.is_file():
                    shutil.copyfile(license_file, dest.parent / license_file.name)
            fp.Models().append(model)
    pcbnew.SaveBoard(str(output), board)
    check = pcbnew.LoadBoard(str(output))
    if circuit_signature(check) != before:
        raise RuntimeError('Model packaging changed pad identities, geometry or nets')
    if len(check.GetTracks()) != len(board.GetTracks()) or len(check.Zones()) != len(board.Zones()):
        raise RuntimeError('Model packaging changed route/zone item counts')
    project = pcb.with_suffix('.kicad_pro')
    if project.exists():
        shutil.copyfile(project, output.with_suffix('.kicad_pro'))
    manifest = {'status': 'engineering-review-not-for-manufacture',
                'source_pcb_sha256': hashlib.sha256(pcb.read_bytes()).hexdigest(),
                'footprints': len(list(board.GetFootprints())), 'populated_footprints': len(changes), 'model_instances': len(records),
                'simplified_or_representative': [name for name in [
                    'Vishay_WSL25122L000FEA', 'Texas_Instruments_TPS25730DREFR',
                    'TDK_InvenSense_INMP441', 'Bosch_BMP280',
                    'TDK_InvenSense_MMICT5848_00_012', 'TDK_InvenSense_ICM_42670_P']
                    if name in {r['library'] for r in records}], 'models': records}
    output.with_suffix('.models.json').write_text(json.dumps(manifest, indent=2))
    print(f'Packaged {len(records)} model instances for {len(changes)} footprints: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pcb')
    parser.add_argument('--parts', required=True)
    parser.add_argument('--source-project', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    package(args.pcb, args.parts, args.source_project, args.output)


if __name__ == '__main__':
    main()
