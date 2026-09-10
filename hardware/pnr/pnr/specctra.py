"""Lossless net identity across case-insensitive Specctra routers.

Export a private board with unique ASCII net IDs, then import the session into
that same board and restore the original names. Never import a raw session into
an original board containing case-only net-name differences.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from pnr.writeback import apply_net_classes, patch_project_rules


def net_aliases(names):
    """Stable, case-insensitively unique names, including case-only originals."""
    names = list(names)
    if len(names) != len(set(names)):
        raise ValueError('Duplicate source net names')
    return {name: f'PNR_NET_{i:06d}' for i, name in enumerate(sorted(names), 1) if name}


def alias_rules(rules, aliases):
    result = copy.deepcopy(rules)
    for cls in result.get('net_classes', []):
        cls['nets'] = [aliases[n] for n in cls.get('nets', [])]
    for pair in result.get('diff_pairs', []):
        pair['p'], pair['n'] = aliases[pair['p']], aliases[pair['n']]
    for match in result.get('length_match', []):
        match['nets'] = [aliases[n] for n in match.get('nets', [])]
    return result


def export_session(pcb_path, dsn_path, map_path, rules):
    import pcbnew
    board = pcbnew.LoadBoard(str(pcb_path))
    nets = [n for n in board.GetNetsByNetcode().values() if n.GetNetCode() > 0]
    aliases = net_aliases(n.GetNetname() for n in nets)
    records = []
    for net in nets:
        original = net.GetNetname()
        records.append({'name': original, 'alias': aliases[original], 'code': net.GetNetCode()})
        net.SetNetname(aliases[original])
    private_pcb = Path(dsn_path).with_suffix('.kicad_pcb').resolve()
    if private_pcb == Path(pcb_path).resolve():
        raise ValueError('Routing export must not overwrite the source PCB')
    private_rules = alias_rules(rules, aliases)
    pcbnew.SaveBoard(str(private_pcb), board)
    patch_project_rules(str(private_pcb.with_suffix('.kicad_pro')), private_rules)
    board = pcbnew.LoadBoard(str(private_pcb))
    apply_net_classes(board, private_rules)
    if not pcbnew.ExportSpecctraDSN(board, str(dsn_path)):
        raise RuntimeError('Specctra export failed')
    Path(map_path).write_text(json.dumps({'schema': 1, 'pcb': str(private_pcb),
                                         'pcb_sha256': hashlib.sha256(private_pcb.read_bytes()).hexdigest(),
                                         'nets': records, 'rules': rules}, indent=2))


def import_session(ses_path, map_path, out_path):
    import pcbnew
    mapping = json.loads(Path(map_path).read_text())
    if mapping['schema'] != 1:
        raise ValueError('Unsupported routing map')
    if Path(out_path).resolve() == Path(mapping['pcb']).resolve():
        raise ValueError('Keep the private routing board unchanged for repeatable imports')
    private_pcb = Path(mapping['pcb'])
    if hashlib.sha256(private_pcb.read_bytes()).hexdigest() != mapping['pcb_sha256']:
        raise ValueError('Private routing board changed after export')
    board = pcbnew.LoadBoard(mapping['pcb'])
    expected = {n['alias'] for n in mapping['nets']}
    actual = {n.GetNetname() for n in board.GetNetsByNetcode().values() if n.GetNetCode() > 0}
    if actual != expected:
        raise ValueError('Routing board does not match its net map')
    if not pcbnew.ImportSpecctraSES(board, str(ses_path)):
        raise RuntimeError('Specctra import failed')
    actual = {n.GetNetname() for n in board.GetNetsByNetcode().values() if n.GetNetCode() > 0}
    if actual != expected:
        raise ValueError('Routing session introduced unexpected nets')
    for record in mapping['nets']:
        net = board.FindNet(record['alias'])
        if net is None:
            raise ValueError(f'Missing routed net {record["alias"]}')
        net.SetNetname(record['name'])
    board.BuildConnectivity()
    pcbnew.SaveBoard(str(out_path), board)
    patch_project_rules(str(Path(out_path).with_suffix('.kicad_pro')), mapping['rules'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    export = subs.add_parser('export')
    export.add_argument('pcb')
    export.add_argument('dsn')
    export.add_argument('--map', required=True)
    export.add_argument('--rules', required=True)
    imp = subs.add_parser('import')
    imp.add_argument('ses')
    imp.add_argument('out')
    imp.add_argument('--map', required=True)
    args = parser.parse_args()
    if args.action == 'export':
        export_session(args.pcb,args.dsn,args.map,json.loads(Path(args.rules).read_text()))
    else:
        import_session(args.ses,args.map,args.out)


if __name__ == '__main__':
    main()
