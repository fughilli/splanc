"""Fingerprint the exact library footprints used by this private host."""
import hashlib,os,re
from pathlib import Path

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def library_inputs(board,config):
 table={}
 for path in (Path(config)/'fp-lib-table',Path(board.GetFileName()).parent/'fp-lib-table'):
  if not path.exists():continue
  for name,uri in re.findall(r'\(lib\s+\(name\s+"([^\"]+)"\).*?\(uri\s+"([^\"]+)"\)',path.read_text(),re.S):table[name]=uri
 inputs={};ids=set()
 for f in board.GetFootprints():
  lib=f.GetFPID().GetLibNickname().c_str();name=f.GetFPID().GetLibItemName().c_str()
  if not lib:continue
  ids.add(lib+':'+name)
  if lib not in table:raise ValueError('Library dependency cannot be resolved: '+lib)
  uri=table[lib].replace('${KIPRJMOD}',str(Path(board.GetFileName()).parent))
  for key,value in os.environ.items():uri=uri.replace('${'+key+'}',value)
  path=Path(uri)/(name+'.kicad_mod')
  if not path.is_file():raise ValueError('Library footprint dependency unavailable: '+str(path))
  inputs[str(path.resolve())]=digest(path)
 return inputs,sorted(ids)
def verify(inputs):
 if any(not Path(p).is_file() or digest(p)!=value for p,value in inputs.items()):raise ValueError('Referenced footprint library changed; restart host')
