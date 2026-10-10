from pathlib import Path
import os,subprocess,sys
run=Path('bazel-out/darwin_arm64-opt-exec-ST-d57f47055a04/bin/hardware/pnr/pnr_fab.runfiles').resolve();py=run/'rules_python~~python~python_3_11_aarch64-apple-darwin/bin/python3';env=dict(os.environ,PYTHONPATH=os.pathsep.join(map(str,[Path(__file__).resolve().parent/'runtime/hardware/pnr',*run.glob('rules_python~~pip~*/site-packages')])),PNR_LOCAL_PRESSURE='1')
raise SystemExit(subprocess.call([str(py),*sys.argv[1:]],env=env))
