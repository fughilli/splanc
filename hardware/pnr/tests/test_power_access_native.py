"""Native routing geometry regression entry point; no mocked copper."""
import unittest
try:
    import pcbnew
except ImportError:
    pcbnew = None

@unittest.skipIf(pcbnew is None, "requires native KiCad Python")
class NativeRuntimeTest(unittest.TestCase):
    def test_native_runtime_available(self):
        self.assertTrue(pcbnew.GetBuildVersion())

def load_tests(loader, tests, pattern):
    if pcbnew is None:
        return tests
    names = ["test_native_electrical", "test_boundary_anchor", "test_pad_entry", "test_reference_guard",
             "test_terminal_repair", "test_adaptive_neck", "test_connected_land",
             "test_pad_entry_neck", "test_land_neck", "test_power_tree_roots", "test_native_pad_angles", "test_qualified_tree_ports", "test_tree_dispatch", "test_native_full_land_access", "test_native_placement_copper"]
    tests.addTests(loader.loadTestsFromNames(names))
    return tests

if __name__ == "__main__":
    unittest.main()
