"""Conservative constant-power hold-up calculation for Splanc's selected bus.

Capacitance must be the effective minimum after tolerance, DC bias and
temperature, not the capacitor label. This calculation cannot establish
 converter stability or a switchover-time bound for the assembled board.
"""
import argparse
import json
import math


def hold_up_seconds(capacitance_f, start_v, minimum_v, load_w, efficiency=1.0):
    if not all(math.isfinite(x) for x in (capacitance_f, start_v, minimum_v, load_w, efficiency)):
        raise ValueError('Inputs must be finite')
    if capacitance_f <= 0 or minimum_v <= 0 or load_w <= 0:
        raise ValueError('Capacitance, minimum voltage and load must be positive')
    if not 0 < efficiency <= 1 or start_v < minimum_v:
        raise ValueError('Invalid efficiency or voltage window')
    return capacitance_f * (start_v ** 2 - minimum_v ** 2) * efficiency / (2 * load_w)


def required_capacitance_f(start_v, minimum_v, load_w, delay_s, efficiency=1.0):
    if not math.isfinite(delay_s):
        raise ValueError('Delay must be finite')
    if delay_s <= 0 or start_v <= minimum_v:
        raise ValueError('Delay and available voltage window must be positive')
    return delay_s / hold_up_seconds(1, start_v, minimum_v, load_w, efficiency)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capacitance-uf', type=float, required=True)
    parser.add_argument('--start-v', type=float, required=True)
    parser.add_argument('--minimum-v', type=float, required=True)
    parser.add_argument('--load-w', type=float, required=True)
    parser.add_argument('--efficiency', type=float, required=True)
    parser.add_argument('--delay-us', type=float, required=True)
    args = parser.parse_args()
    available = hold_up_seconds(args.capacitance_uf * 1e-6, args.start_v,
                                args.minimum_v, args.load_w, args.efficiency)
    needed = required_capacitance_f(args.start_v, args.minimum_v, args.load_w,
                                   args.delay_us * 1e-6, args.efficiency)
    print(json.dumps({'assumptions': vars(args), 'available_us': available * 1e6,
                      'required_effective_uf': needed * 1e6,
                      'energy_margin_ratio': available / (args.delay_us * 1e-6),
                      'excludes': ['ESR step', 'path loss before start voltage',
                                   'converter transient response', 'gate-load timing'],
                      'qualification': False}, indent=2))


if __name__ == '__main__':
    main()
