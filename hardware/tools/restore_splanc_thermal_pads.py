"""Restore duplicate-number thermal and microphone lands after atopile 0.15.8 PCB updates.

The updater can copy the via geometry onto the SMD land when both share a pad
number, and overwrite the microphone's segmented ground-pad primitives.
Restore the checked-in footprint's pads, retaining the board's nets and
component pose. Run after ato build and before placement/export.
"""
import argparse
from pathlib import Path
import pcbnew

PARTS = Path(__file__).resolve().parents[1] / 'splanc_dev/elec/src/parts'
NAMES = {
    'board.pd.ctrl': 'Texas_Instruments_TPS25730DREFR',
    'board.pd.cc_protection': 'Texas_Instruments_TPD6S300ARUKR',
    'board.converter.ic': 'Texas_Instruments_TPS552882RPMR',
    'board.led0.load_sw': 'Texas_Instruments_TPS25200DRVR',
    'board.led1.load_sw': 'Texas_Instruments_TPS25200DRVR',
    'board.mic': 'TDK_InvenSense_MMICT5848_00_012',
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('board', type=Path)
    args = parser.parse_args()
    board = pcbnew.LoadBoard(str(args.board))
    keep_alive = []
    for fp in board.GetFootprints():
        address = next((f.GetText() for f in fp.GetFields() if f.GetName() == 'atopile_address'), '')
        if address not in NAMES:
            continue
        path = next((PARTS / NAMES[address]).glob('*.kicad_mod'))
        template = pcbnew.FootprintLoad(str(path.parent), path.stem)
        keep_alive.append(template)
        if fp.IsFlipped():
            raise ValueError('This source repair expects top-side footprints')
        template.SetOrientation(fp.GetOrientation())
        template.SetPosition(fp.GetPosition())
        # The updater also maps this microphone's comments-layer outline to
        # silkscreen. Restore matching primitive layers from the source.
        if address == 'board.mic':
            remaining = [g for g in template.GraphicalItems() if hasattr(g, 'GetShape')]
            for actual in fp.GraphicalItems():
                if not hasattr(actual, 'GetShape'):
                    continue
                matches = [g for g in remaining if actual.GetShape() == g.GetShape()
                           and actual.GetStart() == g.GetStart() and actual.GetEnd() == g.GetEnd()]
                if matches:
                    # Identical circles exist on both comments and silk layers.
                    # Match one-to-one so neither source primitive is reused.
                    expected = next((g for g in matches if g.GetLayer() == actual.GetLayer()), matches[0])
                    actual.SetLayer(expected.GetLayer())
                    remaining.remove(expected)
        nets = {p.GetNumber(): p.GetNet() for p in fp.Pads()}
        copies = [pcbnew.Cast_to_PAD(p.Duplicate()) for p in template.Pads()]
        old_pads = list(fp.Pads())
        keep_alive.extend(old_pads)
        keep_alive.extend(copies)
        for copy in copies:
            copy.SetParent(fp)
            copy.SetNet(nets[copy.GetNumber()])
            fp.Add(copy)
        for pad in old_pads:
            fp.Remove(pad)
        print('Restored', address)
    pcbnew.SaveBoard(str(args.board), board)

if __name__ == '__main__':
    main()
