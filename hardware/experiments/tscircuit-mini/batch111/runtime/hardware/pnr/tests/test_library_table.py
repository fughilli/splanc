import tempfile
import unittest
from pathlib import Path
from pnr.library_table import library_table

class LibraryTableTest(unittest.TestCase):
    def test_portable_table_deduplicates_library_and_avoids_source_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths=[root/'parts'/'USB'/'one.kicad_mod',root/'parts'/'USB'/'two.kicad_mod']
            text=library_table(paths,portable=True)
            self.assertEqual(text.count('(lib (name'),1)
            self.assertIn('${KIPRJMOD}/footprints/USB',text)
            self.assertNotIn(directory,text)
            self.assertIn(str(root/'parts'/'USB'),library_table(paths))

    def test_ambiguous_library_names_fail(self):
        with self.assertRaises(ValueError):
            library_table(['/one/USB/a.kicad_mod','/two/USB/b.kicad_mod'])

if __name__=='__main__':
    unittest.main()
