import math
import re
import unittest
from sanitize_footprints import ensure_silk_line

class SilkFallbackTest(unittest.TestCase):
    def test_fallback_clears_complete_pad_and_is_idempotent(self):
        source='''(footprint "test"
 (fp_circle (center 0 0) (end 0 2) (layer "F.SilkS"))
 (pad "1" smd rect
  (at -2 0 45)
  (size 1 3)
\t)
 (pad "2" smd rect
  (at 2 0)
  (size 1 3)
\t)
)'''
        result,added=ensure_silk_line(source)
        self.assertTrue(added)
        y=float(re.search(r'\(fp_line\s+\(start [-0-9.]+ ([-0-9.]+)',result)[1])
        self.assertLess(y,-math.hypot(1,3)/2-.2)
        self.assertEqual(ensure_silk_line(result),(result,False))

if __name__=='__main__':
    unittest.main()
