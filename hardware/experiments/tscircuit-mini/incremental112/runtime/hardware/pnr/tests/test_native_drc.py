import json,tempfile,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
from pnr.native_drc import run_drc
class NativeDrcTest(unittest.TestCase):
    def test_timeout_discards_stale_report_and_retries_real_validation(self):
        with tempfile.TemporaryDirectory() as d:
            report=Path(d)/'drc.json';report.write_text('{"violations": [], "unconnected_items": []}')
            count=[]
            def invoke(command,**kwargs):
                self.assertFalse(report.exists());self.assertEqual(kwargs['timeout'],45);count.append(1)
                if len(count)==1:
                    report.write_text('partial');raise subprocess.TimeoutExpired(command,45)
                report.write_text(json.dumps(dict(violations=[],unconnected_items=[{}])))
            with patch('pnr.native_drc.subprocess.run',side_effect=invoke):result=run_drc('cli','board',report)
            self.assertEqual(len(result['unconnected_items']),1);self.assertEqual(len(count),2)
    def test_exhausted_or_incomplete_checks_fail_closed(self):
        for timeout in (True,False):
            with tempfile.TemporaryDirectory() as d:
                report=Path(d)/'drc.json'
                def invoke(command,**kwargs):
                    if timeout:raise subprocess.TimeoutExpired(command,45)
                    report.write_text('{}')
                with patch('pnr.native_drc.subprocess.run',side_effect=invoke):
                    with self.assertRaises((subprocess.TimeoutExpired,ValueError)):run_drc('cli','board',report)
                self.assertFalse(report.exists())
if __name__=='__main__':unittest.main()
