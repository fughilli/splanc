"""Check review ledger completeness and checkpoint identity; not a visual oracle."""

import argparse
import hashlib
import json
from pathlib import Path
from pypdf import PdfReader

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("directory", type=Path)
a = ap.parse_args()
m = json.loads((a.directory / "manifest.json").read_text())
r = json.loads((a.directory / "review.json").read_text())
assert (
    hashlib.sha256(Path(m["board"]).read_bytes()).hexdigest()
    == m["sha256"]
    == r["board_sha256"]
), "stale board/review"
assert r["status"] == "complete", "review pending"
expected = list(range(1, len(m["layers"]) + 1))
assert sorted(r["reviewed_pages"]) == expected, "missing or duplicate page review"
assert len(PdfReader(m["pdf"]).pages) == len(expected), "PDF page mismatch"
assert all(Path(p["image"]).is_file() for p in m["layers"]), "missing page image"
assert r["observations"], "record visual observations"
print(f"Review ledger complete: {len(expected)} pages, checkpoint {m['sha256'][:16]}")

annotations = a.directory / "annotations.json"
if annotations.exists():
    reports = json.loads(annotations.read_text())
    native = json.loads((a.directory / "native" / "annotations.json").read_text())
    assert len(m["layers"]) == 2 * len(reports)
    for i, report in enumerate(reports):
        clean, annotated = m["layers"][2 * i : 2 * i + 2]
        assert clean["kind"] == "clean" and annotated["kind"] == "annotated"
        assert clean["layer"] == annotated["layer"] == report["layer"]
        assert report["parts"] == len(native["parts"])
        assert report["pads"] == sum(
            bool(p["number"]) for f in native["parts"] for p in f["pads"]
        )
        assert report["trace_segments"] == sum(
            t["layer"] == report["layer"] for t in native["tracks"]
        )
        assert report["unplaced_labels"] == 0, "annotation placement failed"
    print("Paired pages and annotation coverage verified")
