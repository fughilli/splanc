"""Continuous provisional silicone carriers spanning MAX terminal-row recesses."""
from pathlib import Path
import cadquery as cq
from generate_enclosures import box
R=Path('output/product-renders-final/max-weather')
for label,y in [('south',7),('north',127)]:
 q=box(12,8.4,0,190,10,.7)
 for i in range(10):
  x=21.5+19*i;q=q.cut(box(x-8.15,9.15,-.1,16.3,8.5,1))
 q=q.rotate((0,0,0),(1,0,0),90).translate((0,y,0))
 assert q.val().isValid() and len(q.val().Solids())==1
 cq.exporters.export(q,str(R/('terminal-seal-carrier-'+label+'.step')))
for p in R.glob('output-seal-*.step'):p.unlink()
print('Exported two continuous terminal sealing carriers')
