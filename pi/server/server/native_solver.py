"""Native (Rust) VIO solver subprocess wrapper.

The final + interim pose-less solves run in //solver:solver_cli — the Rust
port of reconstruction/vio_api (parity-pinned by
//pi/reconstruction:rust_parity_test). Protocol per solve:

    stdin   one JSON problem {detections, imu, ledCount, mapId, createdAt,
            options{maxKeyframes, maxNfev, rejectOutliers, ...}}
    stdout  one §7.5 OutputMap JSON
    stderr  solve_status-shaped progress lines (JSON per line, ~4 Hz)

`--benchmark` runs the canned placement-benchmark solve and reports
`{"ms", "rms"}` — the phone times the SAME solve in wasm, and the two
scores decide where the final solve runs (§7 welcome.solverBenchMs).

The binary rides in runfiles (data dep of //pi/server:serve); the Python
solver remains as an automatic fallback so a source checkout without the
Rust toolchain still works.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

_log = logging.getLogger(__name__)

_RUNFILES_PATH = "_main/solver/solver_cli"


def solver_path() -> Optional[str]:
    """Locate the solver binary: $LEDMAPPER_SOLVER_BIN, then runfiles."""
    env = os.environ.get("LEDMAPPER_SOLVER_BIN")
    if env:
        return env if Path(env).exists() else None
    try:
        from python.runfiles import runfiles

        r = runfiles.Create()
        path = r.Rlocation(_RUNFILES_PATH)
        if path and Path(path).exists():
            return path
    except Exception:
        pass
    return None


def available() -> bool:
    return solver_path() is not None


def solve(
    problem: dict,
    progress_cb: Optional[Callable[[dict], None]] = None,
    timeout_s: float = 1800.0,
) -> dict:
    """Run one solve; returns the OutputMap dict. Raises RuntimeError with
    the solver's message on failure (surfaced as reconstruction_failed)."""
    path = solver_path()
    if path is None:
        raise RuntimeError("native solver binary not found")
    proc = subprocess.Popen(
        [path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    error_lines: list[str] = []

    def read_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                if progress_cb is not None:
                    try:
                        progress_cb(json.loads(line))
                    except Exception:
                        pass
            else:
                error_lines.append(line)

    reader = threading.Thread(target=read_stderr, daemon=True)
    reader.start()
    try:
        stdout, _ = proc.communicate(input=json.dumps(problem), timeout=timeout_s)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError(f"native solver timed out after {timeout_s:.0f}s")
    reader.join(timeout=5.0)
    if proc.returncode != 0:
        detail = "; ".join(error_lines) or f"exit code {proc.returncode}"
        raise RuntimeError(f"native solver failed: {detail}")
    return json.loads(stdout)


def benchmark(timeout_s: float = 300.0) -> Optional[float]:
    """Host score on the canned benchmark solve, ms (None if unavailable)."""
    path = solver_path()
    if path is None:
        return None
    try:
        out = subprocess.run(
            [path, "--benchmark"], capture_output=True, timeout=timeout_s, check=True
        )
        score = json.loads(out.stdout)
        return float(score["ms"])
    except Exception as exc:
        _log.warning("solver benchmark failed: %s", exc)
        return None
