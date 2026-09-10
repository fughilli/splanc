"""Generate dimensioned, simplified VRML bodies for two missing package models.

These are CAD visualization models, not manufacturer mechanical-clearance
certificates. Dimensions come from the TI REF0038A and INMP441 package drawings.
Coordinates match the local Splanc footprints. No logos or markings are invented.
"""
from pathlib import Path

PARTS = Path(__file__).resolve().parents[1] / 'splanc_dev/elec/src/parts'


def box(center, size, color):
    c = ' '.join(f'{v/2.54:.7f}' for v in center)
    s = ' '.join(f'{v/2.54:.7f}' for v in size)
    rgb = ' '.join(str(v) for v in color)
    return f'''Transform {{ translation {c} children [ Shape {{
 appearance Appearance {{ material Material {{ diffuseColor {rgb} shininess 0.35 }} }}
 geometry Box {{ size {s} }}
}} ] }}\n'''


def write(name, filename, body):
    path = PARTS / name / filename
    path.write_text('#VRML V2.0 utf8\n# Simplified dimensioned package; see MODEL_NOTES.md\n' + body)
    return path


def main():
    dark = (0.055, 0.055, 0.060)
    silver = (0.65, 0.65, 0.67)
    gold = (0.65, 0.48, 0.16)
    # TI REF0038A nominal body 6 x 4 x 0.75 mm, 0.2 x 0.35 mm contacts.
    pd = box((0, 0, .4), (6, 4, .70), dark)
    # 13 contacts on each long edge, six on each short edge.
    for x in [i*.4 for i in range(-6, 7)]:
        for y in (-1.825, 1.825):
            pd += box((x, y, .025), (.2, .35, .05), silver)
    for y in [(-1 + i*.4) for i in range(6)]:
        for x in (-2.825, 2.825):
            pd += box((x, y, .025), (.35, .2, .05), silver)
    write('Texas_Instruments_TPS25730DREFR', 'TPS25730_REF0038A_body.wrl', pd)
    # INMP441 bottom-port microphone: 3.76 x 4.72 x 1.00 mm envelope.
    mic = box((0, 0, .10), (3.76, 4.72, .20), dark)
    mic += box((0, 0, .60), (3.76, 4.72, .80), silver)
    for x in (-1.33, 1.33):
        for y in (-1.58, -.53, .52, 1.57):
            mic += box((x, y, .0125), (.6, .4, .025), gold)
    for y in (-1.58, 1.57):
        mic += box((0, y, .0125), (.6, .4, .025), gold)
    write('TDK_InvenSense_INMP441', 'INMP441_body.wrl', mic)
    # T5848 package envelope, centered on the local footprint outline.
    mic5848 = box((0, 0, .10), (3.5, 2.65, .20), dark)
    mic5848 += box((0, 0, .655), (3.5, 2.65, .91), silver)
    write('TDK_InvenSense_MMICT5848_00_012', 'T5848_body.wrl', mic5848)
    # ICM-42670-P nominal envelope: 3.0 x 2.5 x 0.76 mm (DS package table).
    imu = box((0, 0, .405), (3.0, 2.5, .71), dark)
    for x in (-1.25, 1.25):
        for y in (-.75, -.25, .25, .75):
            imu += box((x, y, .025), (.45, .25, .05), gold)
    for y in (-1.0, 1.0):
        for x in (-.5, 0, .5):
            imu += box((x, y, .025), (.25, .45, .05), gold)
    write('TDK_InvenSense_ICM_42670_P', 'ICM42670_body.wrl', imu)


if __name__ == '__main__':
    main()
