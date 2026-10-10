"""A repeated terminal number must retain its distinct exposed pad and hole."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


@unittest.skipUnless(importlib.util.find_spec('pcbnew'), 'requires native KiCad')
class SourceFootprintsTest(unittest.TestCase):
    def test_restores_shapes_preserves_terminal_nets_and_is_idempotent(self):
        import pcbnew as k
        from pnr.source_footprints import restore
        with tempfile.TemporaryDirectory() as directory:
            lib=Path(directory)/'Fixture.pretty';lib.mkdir()
            template=k.FOOTPRINT(None)
            template.SetFPID(k.LIB_ID('Fixture.pretty','thermal'))
            for through in (False,True):
                p=k.PAD(template);p.SetNumber('7');p.SetShape(k.PAD_SHAPE_CIRCLE if through else k.PAD_SHAPE_RECT)
                p.SetAttribute(k.PAD_ATTRIB_PTH if through else k.PAD_ATTRIB_SMD)
                p.SetSize(k.VECTOR2I(450000,450000) if through else k.VECTOR2I(1700000,1700000))
                if through:p.SetDrillSize(k.VECTOR2I(200000,200000))
                layers=k.LSET.AllCuMask() if through else k.LSET();layers.AddLayer(k.F_Cu)
                p.SetLayerSet(layers);template.Add(p)
            writer=k.PCB_IO_KICAD_SEXPR();writer.FootprintSave(str(lib),template)
            board=k.BOARD();board.SetCopperLayerCount(4);net=k.NETINFO_ITEM(board,'return');board.Add(net)
            old=k.FOOTPRINT(template);old.SetReference('U987');board.Add(old)
            identity=old.m_Uuid.AsString()
            for p in old.Pads():
                p.SetNetCode(net.GetNetCode())
                p.SetAttribute(k.PAD_ATTRIB_PTH);p.SetShape(k.PAD_SHAPE_CIRCLE)
                p.SetSize(k.VECTOR2I(450000,450000));p.SetDrillSize(k.VECTOR2I(200000,200000));p.SetLayerSet(k.LSET.AllCuMask())
            field=k.PCB_FIELD(old,k.FIELD_T_USER,'atopile_address');field.SetText('board.part');old.Add(field)
            files=list(lib.glob('*.kicad_mod'))
            result=restore(board,files)
            self.assertEqual(len(result),1)
            fixed=next(iter(board.GetFootprints()))
            self.assertEqual(fixed.GetReference(),'U987')
            self.assertEqual(fixed.m_Uuid.AsString(),identity)
            self.assertEqual({p.GetNetname() for p in fixed.Pads()},{'return'})
            self.assertEqual(sum(p.GetAttribute()==k.PAD_ATTRIB_SMD for p in fixed.Pads()),1)
            self.assertEqual(sum(bool(p.GetDrillSize().x) for p in fixed.Pads()),1)
            saved=Path(directory)/'restored.kicad_pcb'
            k.SaveBoard(str(saved),board)
            reloaded=k.LoadBoard(str(saved))
            self.assertEqual(restore(reloaded,files),[])
            self.assertEqual(restore(board,files),[])
            board.Add(k.PCB_TRACK(board))
            with self.assertRaisesRegex(ValueError,'source-only'):
                restore(board,files)


if __name__=='__main__':unittest.main()
