"""Net identity must survive routing even for atopile's EN/en pair."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from pnr.specctra import alias_rules, net_aliases, export_session, import_session

class AliasTest(unittest.TestCase):
    def test_case_only_names_are_distinct_and_deterministic(self):
        names = ['en', 'EN', 'PNR_NET_000001', 'x y', '"quoted"']
        aliases = net_aliases(names)
        self.assertEqual(aliases, net_aliases(reversed(names)))
        self.assertEqual(len(set(a.casefold() for a in aliases.values())),len(names))
        self.assertNotEqual(aliases['EN'],aliases['en'])
        with self.assertRaises(ValueError):
            net_aliases(['EN','EN'])

    def test_rules_retain_separate_net_membership(self):
        aliases = net_aliases(['EN','en'])
        source = {'net_classes':[{'name':'logic','nets':['EN']}],
                  'diff_pairs':[{'p':'EN','n':'en'}],
                  'length_match':[{'nets':['en']}]}
        result = alias_rules(source,aliases)
        self.assertEqual(result['net_classes'][0]['nets'],[aliases['EN']])
        self.assertEqual(result['diff_pairs'][0]['n'],aliases['en'])
        self.assertEqual(source['diff_pairs'][0]['n'],'en')

@unittest.skipUnless(importlib.util.find_spec('pcbnew') is not None, 'requires KiCad')
class LiveIdentityTest(unittest.TestCase):
    def test_session_restores_case_sensitive_nets_and_track_membership(self):
        import pcbnew
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            board = pcbnew.BOARD()
            for name in ('EN','en'):
                net = pcbnew.NETINFO_ITEM(board,name)
                board.Add(net)
                fp = pcbnew.FOOTPRINT(board)
                fp.SetReference('J'+str(net.GetNetCode()))
                board.Add(fp)
                pad = pcbnew.PAD(fp)
                pad.SetNumber('1')
                pad.SetSize(pcbnew.VECTOR2I(1000000,1000000))
                pad.SetNet(net)
                fp.Add(pad)
            pcbnew.SaveBoard(str(root/'source.kicad_pcb'),board)
            export_session(root/'source.kicad_pcb',root/'private.dsn',root/'map.json',{})
            mapping = json.loads((root/'map.json').read_text())
            aliases = {n['name']:n['alias'] for n in mapping['nets']}
            # A controlled session routes the two nets to distinct y positions.
            session = ('(session private (base_design private) (routes '
                       '(resolution um 10) (library_out) (network_out '
                       f'(net {aliases["EN"]} (wire (path F.Cu 2000 100000 -100000 200000 -100000))) '
                       f'(net {aliases["en"]} (wire (path F.Cu 2000 100000 -200000 200000 -200000))) )))')
            (root/'result.ses').write_text(session)
            import_session(root/'result.ses',root/'map.json',root/'result.kicad_pcb')
            result = pcbnew.LoadBoard(str(root/'result.kicad_pcb'))
            tracks = {t.GetNetname():t.GetStart().y for t in result.GetTracks()}
            self.assertEqual(tracks,{'EN':10000000,'en':20000000})

if __name__ == '__main__':
    unittest.main()
