from pathlib import Path
import os,subprocess,sys
root=Path.cwd();run=(root/'bazel-out/darwin_arm64-opt-exec-ST-d57f47055a04/bin/hardware/pnr/pnr_fab.runfiles').resolve();py=run/'rules_python~~python~python_3_11_aarch64-apple-darwin/bin/python3';mode=sys.argv[1];d=root/('output/fresh-pnr-20260919/mesh98-baseline-source' if mode=='baseline-v1' else 'output/fresh-pnr-20260919/mesh98-candidate-source');env=dict(os.environ,PYTHONPATH=os.pathsep.join(map(str,[d,*run.glob('rules_python~~pip~*/site-packages')])),PNR_LOCAL_PRESSURE='1' if mode=='candidate-v2' else '0')
raise SystemExit(subprocess.call([str(py),str(Path(__file__).with_name('mesh98-inner.py')),mode],env=env))
