"""Native copper polygons are the authority for non-cardinal pad orientation."""
import math
import unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.native_electrical import add_track
from pnr.pad_entry import witness,neck_witness
from pnr.electrical import compile_policy

class NativePadAngleTest(unittest.TestCase):
    def test_valid_off_center_disk_matches_native_copper(self):
        for angle in (30,45,60,-30,-45):
            for shape in (k.PAD_SHAPE_RECT,k.PAD_SHAPE_ROUNDRECT,k.PAD_SHAPE_OVAL):
                with self.subTest(angle=angle,shape=shape):
                    b=board();p=pad(b,'A','1','rail',(5,5),(4,1));p.SetShape(shape);p.SetOrientationDegrees(angle)
                    a=math.radians(angle);point=(5+1.3*math.cos(a),5-1.3*math.sin(a))
                    t=k.PCB_TRACK(b);t.SetLayer(k.F_Cu);t.SetWidth(1000000);t.SetStart(k.VECTOR2I(*[round(v*1e6) for v in point]));t.SetEnd(t.GetStart())
                    polygon=k.SHAPE_POLY_SET();p.TransformShapeToPolygon(polygon,k.F_Cu,0,1000,k.ERROR_INSIDE)
                    self.assertTrue(polygon.Contains(t.GetStart()))
                    self.assertTrue(witness(p,t,1))
    def test_reflected_point_outside_native_pad_is_never_qualified(self):
        for angle in (30,45,60,-30,-45):
            with self.subTest(angle=angle):
                b=board();p=pad(b,'A','1','rail',(5,5),(4,1));p.SetOrientationDegrees(angle)
                a=math.radians(angle);point=(5+1.3*math.cos(a),5+1.3*math.sin(a))
                t=k.PCB_TRACK(b);t.SetLayer(k.F_Cu);t.SetWidth(1000000);t.SetStart(k.VECTOR2I(*[round(v*1e6) for v in point]));t.SetEnd(t.GetStart())
                polygon=k.SHAPE_POLY_SET();p.TransformShapeToPolygon(polygon,k.F_Cu,0,1000,k.ERROR_INSIDE)
                self.assertFalse(polygon.Contains(t.GetStart()))
                self.assertFalse(witness(p,t,1))
    def test_short_neck_uses_same_native_rotation_convention(self):
        b=board();p=pad(b,'A','1','rail',(5,5),(2,.4));p.SetOrientationDegrees(45)
        u=(math.sqrt(.5),-math.sqrt(.5));start=tuple(5+.8*v for v in u);end=tuple(5+1.1*v for v in u)
        neck=add_track(b,'rail',k.F_Cu,start,end,.4);feed=add_track(b,'rail',k.F_Cu,end,tuple(5+2*v for v in u),1.5)
        rules=compile_policy({'fab':{'track_width_mm':.2}},[dict(ref='A',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})],dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005))
        self.assertTrue(neck_witness(p,neck,1.5,[neck,feed],rules))

if __name__=='__main__':unittest.main()
