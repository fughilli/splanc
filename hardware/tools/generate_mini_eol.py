#!/usr/bin/env python3
"""Generate both mating footprints from MINI-EOL-V1. No KiCad runtime needed.

The DUT library footprint is F.Cu, flipped around X onto B.Cu by placement.
The fixture remains on F.Cu; its local KiCad Y is opposite the shared Y-up frame.
"""
import argparse
import json
from pathlib import Path

HARDWARE = Path(__file__).resolve().parents[1]
SPEC = HARDWARE / 'interfaces/mini-eol-v1.json'

def footprint(spec, fixture=False):
    name = 'MINI-EOL-V1-POGOS' if fixture else spec['id']
    lines = [f'(footprint "{name}" (version 20241229) (generator "splanc")',
             ' (layer "F.Cu")',
             ' (attr through_hole)' if fixture else ' (attr smd exclude_from_pos_files exclude_from_bom)',
             f' (fp_text reference "{"J1" if fixture else "TP1"}" (at 0 -7) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))',
             f' (fp_text value "{name}" (at 0 7) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))',
             ' (fp_rect (start -5.25 -6.5) (end 5.25 6.5) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))']
    for p in spec['pads']:
        x, y = p['x_mm'], p['y_mm'] * (-1 if fixture else 1)
        if fixture:
            body = 'thru_hole circle (size 1.4 1.4) (drill 0.65) (layers "*.Cu" "*.Mask")'
        else:
            d = spec['pad_diameter_mm']
            body = f'smd circle (size {d} {d}) (layers "F.Cu" "F.Mask") (solder_mask_margin {spec["mask_expansion_mm"]})'
        lines.append(f' (pad "{p["number"]}" {body} (at {x:.2f} {y:.2f}))')
    y = -5.08 if fixture else 5.08
    lines.append(f' (fp_text user "1" (at -5.9 {y}) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))))')
    return '\n'.join(lines) + '\n)\n'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    spec = json.loads(SPEC.read_text())
    paths = [(HARDWARE / 'splanc_dev/elec/src/parts/Splanc_Mini_EOL_V1/MINI-EOL-V1.kicad_mod', False),
             (HARDWARE / 'splanc_eol_tester/elec/footprints/Splanc_Mini_EOL.pretty/MINI-EOL-V1-POGOS.kicad_mod', True)]
    assert [p['number'] for p in spec['pads']] == list(range(1,21))
    assert len({(p['x_mm'],p['y_mm']) for p in spec['pads']}) == 20
    for path, fixture in paths:
        value = footprint(spec, fixture)
        if args.check:
            if not path.is_file() or path.read_text() != value:
                raise SystemExit(f'Stale interface footprint: {path}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
    print('Both mating footprints match MINI-EOL-V1')

if __name__ == '__main__':
    main()
