#!/usr/bin/env python3
"""Check critical power/sensor connections in an actual generated Splanc PCB.

Run with KiCad's Python (pcbnew), for each factory assembly. This checks the
netlist and selected footprint hazards; it does not replace ERC, DRC, thermal
analysis, power sequencing tests, or pack qualification.
"""
import argparse
import json
from pathlib import Path
import pcbnew


def check(path, require_layout=False):
    board = pcbnew.LoadBoard(str(path))
    footprints = {}
    for fp in board.GetFootprints():
        fields = {f.GetName(): f.GetText() for f in fp.GetFields()}
        address = fields.get("atopile_address")
        if address:
            if address in footprints:
                raise ValueError("duplicate source address: " + address)
            footprints[address] = fp
    results = []

    def net(address, pin):
        fp = footprints[address] if address in footprints else footprints['board.' + address]
        hits = [p.GetNetCode() for p in fp.Pads() if p.GetNumber() == str(pin)]
        if not hits or len(set(hits)) != 1:
            raise ValueError(f"missing/ambiguous pad {address}.{pin}: {hits}")
        return hits[0]

    def isolated(address, pin):
        code = net(address, pin)
        return code == 0 or sum(p.GetNetCode() == code for fp in board.GetFootprints() for p in fp.Pads()) == 1

    def require(label, condition):
        results.append({"check": label, "passed": bool(condition)})

    def same(label, *pins):
        codes = [net(*p) for p in pins]
        require(label, codes[0] != 0 and len(set(codes)) == 1)

    def separate(label, *pins):
        codes = [net(*p) for p in pins]
        require(label, all(codes) and len(set(codes)) == len(codes))

    ground = ('usbc', 'A1B12')
    # USB receptacle aliases all ground and supply contacts in its atomic part.
    same('main ground reaches the power IC ground pads', ground,
         ('pd.ctrl', 39), ('charger.ic', 27), ('converter.ic', 24), ('mux.ic', 37))
    for address, number, expected in [('pd.ctrl', '39', 4), ('pd.cc_protection', '21', 1),
                                       ('converter.ic', '24', 1), ('led0.load_sw', '7', 1),
                                       ('led1.load_sw', '7', 1)]:
        fp = footprints.get(address) or footprints['board.' + address]
        vias = [p for p in fp.Pads() if p.GetNumber() == number and
                p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
        require(f'{address} explicit ground thermal vias', len(vias) == expected and
                all(p.GetDrillSize().x == 200000 and p.GetSize().x == 450000 and
                    not p.GetLayerSet().Contains(pcbnew.B_Mask) and
                    not p.GetLayerSet().Contains(pcbnew.F_Paste) for p in vias))
        lands = [p for p in fp.Pads() if p.GetNumber() == number and
                 p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
        require(f'{address} retains exposed solder land', len(lands) == 1 and
                lands[0].GetNetCode() != 0 and
                all(p.GetNetCode() == lands[0].GetNetCode() for p in vias))
    separate('raw USB, negotiated USB, selected bus, battery and 5V stay isolated',
             ('pd.ctrl', 23), ('pd.ctrl', 20), ('converter.ic', 3),
             ('bat_conn', 2), ('buck', 1))
    same('USB enters PD controller and raw VBUS clamp', ('usbc', 'A4B9'),
         ('pd.ctrl', 23), ('pd.vbus_tvs', 4))
    same('charger uses negotiated USB, not battery/system bus',
         ('pd.ctrl', 20), ('charger.ic', 2))
    same('USB mux input FET drain receives negotiated VBUS',
         ('pd.ctrl', 20), ('mux.input_fet1', 2))
    same('battery mux input FET drain receives protected pack',
         ('bat_conn', 2), ('mux.input_fet2', 2))
    for channel in (1, 2):
        same(f'mux channel {channel} FET sources are back-to-back',
             (f'mux.input_fet{channel}', 3), (f'mux.output_fet{channel}', 1))
    same('USB selected status reaches MCU and logic pullup', ('esp', 11), ('mux.ic', 9),
         ('mux.usb_status_pullup._p', 2))
    same('USB holdoff GPIO reaches base resistor', ('esp', 23), ('mux.usb_holdoff_base._p', 1))
    same('USB holdoff transistor grounds emitter', ground, ('mux.usb_holdoff_q', 2),
         ('mux.usb_holdoff_pd._p', 2))
    same('USB holdoff collector controls only channel 1 disable', ('mux.ic', 8),
         ('mux.usb_holdoff_q', 3), ('mux.usb_enable_pullup._p', 2))
    separate('USB holdoff preserves pullup supply isolation', ('mux.ic', 8), ('mux.ic', 13))
    same('logic buck receives regulated 5V', ('buck', 1), ('buck', 4),
         ('converter.shunt._p', 2))
    separate('charger SYS and battery are not shorted', ('charger.ic', 25), ('bat_conn', 2))
    same('PD DRAIN island joins all required pads', ('pd.ctrl', 15), ('pd.ctrl', 30), ('pd.ctrl', 40))
    separate('PD DRAIN island is isolated from ground/VBUS', ('pd.ctrl', 15), ground, ('pd.ctrl', 23))
    same('CC1 routes through protection', ('usbc', 'A5'), ('pd.cc_protection', 4), ('pd.cc_protection', 7))
    same('protected CC1 reaches controller', ('pd.cc_protection', 12), ('pd.ctrl', 28))
    same('CC2 routes through protection', ('usbc', 'B5'), ('pd.cc_protection', 5), ('pd.cc_protection', 6))
    same('protected CC2 reaches controller', ('pd.cc_protection', 11), ('pd.ctrl', 29))
    separate('CC channels and protection boundaries remain separate',
             ('usbc', 'A5'), ('usbc', 'B5'), ('pd.ctrl', 28), ('pd.ctrl', 29))
    same('CC protector starts from VBUS-derived PD LDO', ('pd.ctrl', 1),
         ('pd.cc_protection', 10))
    same('CC protector grounds and mandated NC pins', ground,
         ('pd.cc_protection', 8), ('pd.cc_protection', 13),
         ('pd.cc_protection', 16), ('pd.cc_protection', 17),
         ('pd.cc_protection', 18), ('pd.cc_protection', 21))
    separate('gauge low-side shunt separates pack negative from system ground', ('bat_conn', 1), ground)
    same('gauge ground is on battery side', ('bat_conn', 1), ('gauge.ic', 8), ('gauge.shunt_a._p', 1))
    same('charger and mux share protected battery positive', ('bat_conn', 2), ('charger.ic', 22))
    separate('gauge regulator input/output isolate 2S from low-voltage gauge', ('gauge.supply', 1), ('gauge.ic', 6))
    same('gauge regulator feeds REGIN and CE', ('gauge.supply', 5), ('gauge.ic', 6), ('gauge.ic', 5))
    same('ICM address select, sync and reserved pins grounded', ground,
         ('mpu', 1), ('mpu', 7), ('mpu', 2), ('mpu', 3), ('mpu', 10), ('mpu', 11))
    same('ICM I2C mode and supplies use 3V3A', ('mpu', 8), ('mpu', 5), ('mpu', 12), ('compass', 'B1'))
    same('ICM interrupt reaches GPIO21', ('mpu', 4), ('esp', 19))
    same('sensor I2C clock bus', ('mpu', 13), ('bmp', 2), ('compass', 'A2'))
    same('sensor I2C data bus', ('mpu', 14), ('bmp', 4), ('compass', 'B2'))
    same('compass ground and supply bypass', ground, ('compass', 'A1'), ('compass_reservoir._p', 2))
    same('compass reservoir on VDD', ('compass', 'B1'), ('compass_reservoir._p', 1))
    same('barometer grounds and address select', ground, ('bmp', 3), ('bmp', 8), ('bmp', 9), ('bmp', 5))
    same('barometer filtered supplies and I2C CSB strap', ('bmp_supply_r._p', 2), ('bmp', 1), ('bmp', 10), ('bmp', 6))
    separate('barometer inrush resistor remains in series', ('bmp_supply_r._p', 1), ('bmp', 10))
    same('microphone regulated 1V8 domain', ('mic_supply', 5), ('mic', 7), ('mic_sck_shift', 6), ('mic_ws_shift', 6), ('mic_sd_shift', 1), ('mic_sd_shift', 5))
    separate('microphone supply separated from 3V3A', ('mic', 7), ('mpu', 8))
    same('microphone left channel and grounds', ground, ('mic', 2), ('mic', 3), ('mic_supply', 2))
    require('microphone activity detect pins unused', isolated('mic', 4) and isolated('mic', 5))
    same('microphone clock translator input', ('esp', 16), ('mic_sck_shift', 3))
    same('microphone word-select translator input', ('esp', 17), ('mic_ws_shift', 3))
    same('microphone data translator output', ('esp', 18), ('mic_sd_shift', 4))
    same('microphone clock translated to 1V8', ('mic_sck_shift', 4), ('mic', 6))
    same('microphone word select translated to 1V8', ('mic_ws_shift', 4), ('mic', 1))
    same('microphone data translated from 1V8', ('mic_sd_shift', 3), ('mic', 8), ('mic_data_pd._p', 1))
    for name in ['mic_sck_shift', 'mic_ws_shift']:
        same(name + ' direction and 3V3 supply', (name, 1), (name, 5), ('mpu', 8))
    same('microphone data translator 3V3 output supply', ('mic_sd_shift', 6), ('mpu', 8))
    holes = [p for p in footprints['board.mic'].Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH]
    require('microphone has a 0.5mm unplated acoustic opening',
            any(abs(p.GetDrillSize().x / 1e6 - .5) < .001 for p in holes))
    require('legacy tester high-voltage pins disconnected', all(isolated('eol', p) for p in [1, 3, 4]))
    same('factory charger strap reaches PROG and ground', ('charger_program._p', 1), ('charger.ic', 20))
    same('factory charger strap ground', ('charger_program._p', 2), ground)
    for name, pin in [('battery_uvr', 24), ('battery_uvf', 25), ('battery_ov', 23)]:
        same(name + ' factory top resistor starts at battery', (name + '_top._p', 1), ('bat_conn', 2))
    return {"board": str(path), "components": len(footprints), "checks": results,
            "passed": all(r['passed'] for r in results)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('boards', nargs='+', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--require-layout', action='store_true')
    args = parser.parse_args()
    reports = [check(p, args.require_layout) for p in args.boards]
    text = json.dumps(reports, indent=2)
    if args.output:
        args.output.write_text(text + '\n')
    print(text)
    return 0 if all(r['passed'] for r in reports) else 1


if __name__ == '__main__':
    raise SystemExit(main())
