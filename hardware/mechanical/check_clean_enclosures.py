"""Independent geometry checks for the fresh parametric family build."""
from pathlib import Path
import json,gzip,tempfile
import cadquery as cq
from build_clean_enclosures import box,cyl,SPEC,HERE
R=Path('output/compact-handheld-r9');report={}
def read(p,n):return cq.importers.importStep(str(R/p/(n+'.step')))
def vol(q):return q.val().Volume()
def expect_clear(results,n,a,b):
 results[n]=vol(a.intersect(b));assert results[n]<1e-4,(n,results[n])
for p in ('mini','splanc','max'):
 b,l=read(p,'base'),read(p,'lid');shell=b.union(l);checks={}
 for n,q in [('base',b),('lid',l)]:assert q.val().isValid() and len(q.val().Solids())==1,(p,n)
 expect_clear(checks,'shells',b,l)
 logo=read(p,'logo-white-inlay');expect_clear(checks,'logo',logo,l)
 assert vol(logo.translate((0,0,-.7)).cut(l))<1e-4,(p,'inlay backing')
 if p=='max':
  with tempfile.NamedTemporaryFile(suffix='.step') as f:
   f.write(gzip.decompress((HERE/'assets/pi5-visible-ports.step.gz').read_bytes()));f.flush();pi=cq.importers.importStep(f.name).rotate((0,0,0),(0,0,1),90).translate((285,28,8))
  expect_clear(checks,'Pi versus shell',pi,shell)
  for name in ('lv-pcb-envelope','active-cooler-envelope','usb-jumper-pcb-envelope','usb-male-A-envelope','usb-male-C-envelope'):expect_clear(checks,name,read(p,name),shell)
  interface=json.loads((HERE.parent/'splanc_max/interface.json').read_text());design=json.loads((HERE.parent/'splanc_max/design.json').read_text())
  power=interface['boards']['power'];components={c['ref']:c for c in design['boards']['power']['components']}
  header=cq.importers.importStep(str(HERE/'assets/max-connectors/degson-2edgrc-3-header-normalized.step'))
  for connector in power['connectors']:
   if connector['kind']!='led_output3':continue
   component=components[connector['ref']];x,y=component['position'];rotation=component['rotation']
   expect_clear(checks,connector['ref']+' header',header.rotate((0,0,0),(0,0,1),rotation).translate((7+x,7+y,9.6)),shell)
  from generate_enclosures import board_shape
  expect_clear(checks,'power PCB',board_shape(power,(7,7,8)),shell)
  lug=cq.importers.importStep(str(HERE/'assets/max-connectors/wurth-5580510.step'))
  for y in (52,82):expect_clear(checks,f'power lug {y}',lug.rotate((0,0,0),(0,0,1),-90).translate((-15.5,y,17.25)),shell)
  for n,bar in enumerate(interface['power']['busbars']):expect_clear(checks,f'busbar {n}',box(7+bar['x'],7+bar['y'],11,bar['length_mm'],bar['width_mm'],bar['thickness_mm']),shell)
  hat=read(p,'lv-pcb-envelope');expect_clear(checks,'HAT 1mm allowance',hat.translate((0,0,-1)),pi)
  expect_clear(checks,'cooler 1mm allowance',hat.translate((0,0,-1)),read(p,'active-cooler-envelope'))
  expect_clear(checks,'finger approach',box(266,114.3,-.5,17.5,20,13),shell)
  # Positive material probes: excluded Pi ports must have continuous exterior walls.
  for x in (238,255.9):assert vol(box(x-4,132,10,8,1,8).cut(b))<1e-5,('USB cover',x)
  for y in (53.8,67.2):assert vol(box(290,y-4,9,1,8,7).cut(b))<1e-5,('HDMI cover',y)
  expect_clear(checks,'power plug approach',box(282,34,8,12,10,5),shell)
  assert abs(l.val().BoundingBox().zmax-43)<1e-5
 else:
  d=SPEC['handheld'][p];dz=SPEC['handheld'].get('assembly_z_shift_mm',0)
  assert abs(l.val().BoundingBox().zmax-d['outside_height_mm'])<1e-5
  assert abs(b.val().BoundingBox().zmin)<1e-5
  assert 4.0+dz-SPEC['handheld']['floor']>=.7999, 'connector-pin clearance'
  assert abs(read(p,'button-flexure-strip').val().BoundingBox().zmax-(16.9+dz))<.01
  jst=cq.importers.importStep('hardware/splanc_dev/elec/src/parts/JST_B3B_PH_K_S_LF__SN/CONN-TH_B3B-PH-K-S.step')
  for x,y in d['led_ports']:
   expect_clear(checks,f'JST {y}',jst.rotate((0,0,0),(0,0,1),90).translate((x,y,7.4+dz)),shell)
   expect_clear(checks,f'JST plug {y}',box(x-4.3,y-4.6,13.5+dz,8.6,9.2,30),shell)
  usb=cq.importers.importStep('/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels/Connector_USB.3dshapes/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.step').translate((d['usb_x'],2.225,7.4+dz))
  expect_clear(checks,'USB body',usb,shell)
  for j in (1,2):expect_clear(checks,f'lightpipe {j}',read(p,f'lightpipe-{j}'),shell)
 report[p]=checks;print(p,'PASS',checks,flush=True)
(R/'fit-validation.json').write_text(json.dumps(report,indent=2))
