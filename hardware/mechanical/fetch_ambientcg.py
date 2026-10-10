"""Fetch the four user-selected CC0 ambientCG assets; cache and hash source ZIPs."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess,zipfile,hashlib,json
root=Path('output/ambientcg');root.mkdir(exist_ok=True)
names=['Plastic012B_2K-JPG.zip','Plastic013A_2K-JPG.zip','Plastic016A_2K-JPG.zip','IndoorEnvironmentHDRI002_4K.zip']
def fetch(name):
 p=root/name;url='https://ambientcg.com/get?file='+name
 if not p.exists():subprocess.run(['curl','-fL','--retry','2',url,'-o',str(p)],check=True)
 folder=root/p.stem;folder.mkdir(exist_ok=True)
 with zipfile.ZipFile(p) as z:
  assert z.testzip() is None
  for item in z.namelist():assert not Path(item).is_absolute() and '..' not in Path(item).parts
  z.extractall(folder)
 return {'id':name.split('_')[0],'source':'https://ambientcg.com/view?id='+name.split('_')[0],'download':url,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'license':'CC0','license_url':'https://docs.ambientcg.com/license/'}
with ThreadPoolExecutor(max_workers=4) as pool:records=list(pool.map(fetch,names))
(root/'sources.json').write_text(json.dumps(records,indent=2)+'\n')
Path('hardware/mechanical/assets/ambientcg-sources.json').write_text(json.dumps(records,indent=2)+'\n')
print('Verified',len(records),'assets')
