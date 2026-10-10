"""Freeze display-only board placements from the mechanical workflow's snapshots.
Package bodies are illustrative envelopes; never writes an electrical design.
"""
from pathlib import Path
import json,hashlib,math,re
R=Path.cwd(); result={'schema':1,'note':'Saved board placements; simplified component shapes. Splanc GNSS and MAX UWB/GNSS options shown; MAX option placements are display-only concepts.','sources':{},'products':{}}
def read(path):
 p=R/path;result['sources'][path]=hashlib.sha256(p.read_bytes()).hexdigest();return json.loads(p.read_text())
mini=read('output/mechanical/mini-board.json')
splanc=read('hardware/splanc/design.json')['boards']['gps']
maxpower=read('output/mechanical/max-power-board.json')
localization=read('hardware/splanc_max/localization-options.json')
roles={
 'board.mpu':('Motion','ICM-42670-P · six-axis accelerometer and gyroscope.',[3,2.5,1]),
 'board.compass':('Compass','MMC5603NJ · three-axis magnetic field sensor.',[.8,.8,.5]),
 'board.bmp':('Pressure & temperature','BMP580 · barometric pressure and temperature sensing.',[2,2,.8]),
 'board.mic':('Microphone','T5848 · digital MEMS microphone for audio input.',[3.5,2.7,1]),
 'board.led0.ina':('LED 1 telemetry','INA226 · current and bus-voltage monitoring for output 1.',[3,3,1]),
 'board.led1.ina':('LED 2 telemetry','INA226 · current and bus-voltage monitoring for output 2.',[3,3,1]),
 'board.esp.uwb':('Ultra-wideband','Qorvo DWM3000 · ultra-wideband radio for ranging.',[23,13,2.9]),
 'gps.gnss':('GNSS · optional','u-blox MAX-M10S · satellite positioning, fitted on the GNSS variant.',[9.7,10,2.5]),
}
for sku,board in [('mini',mini),('splanc',splanc),('max',maxpower)]:
 output={'components':[],'sensors':[],'buttons':[]};result['products'][sku]=output
 for c in board['components']:
  ref,addr=c['ref'],c.get('address','');x,y=c['position'];z=5.8
  if sku=='max':x+=45;y+=7;z=9.6
  angle=math.radians(c.get('rotation',0));role=roles.get(addr);optional=addr.startswith('gps.')
  if sku=='max':
   if ref in ['U50','U51','U52','U53','U54']:
    n=int(ref[1:])-50;role=(f'Current · {4*n+1}–{4*n+4}','INA4180 · four-channel current-sense amplifier. Five banks monitor all twenty LED outputs.',[4.4,5,1.2])
   elif ref=='U9':role=('Telemetry ADC','MCP3208 · eight-channel ADC digitizes multiplexed current readings and the divided DC-bus voltage.',[3.9,9.9,1.5])
  if addr.startswith('board.btn_'):
   label={'reset':'Reset','boot':'Boot','user1':'User 1','user2':'User 2'}[addr.split('_')[-1]]
   desc={'Reset':'Restarts the controller.','Boot':'Boot/programming button.','User 1':'User input 1; behavior is assigned by firmware.','User 2':'User input 2; behavior is assigned by firmware.'}[label]
   output['buttons'].append(dict(id=addr.split('.')[-1],label=label,description=desc,x=round(x,3)))
  # Real visible connector CAD and button caps are already supplied separately.
  if ref.startswith(('J','CN','SW','USB','TP','MH')) or '.conn' in addr:continue
  size=[1.0,.5,.45] if ref.startswith(('R','C')) else [3,3,1]
  foot=c.get('footprint','')
  m=re.search(r'_L([\d.]+)-W([\d.]+)',foot)
  if m:size=[float(m[1]),float(m[2]),1]
  if 'C0805' in foot:size=[2,1.25,.9]
  if 'C0603' in foot:size=[1.6,.8,.8]
  if addr in ['board.esp','board.esp.wireless']:size=[18,25.5,3]
  if addr=='board.esp.p4':size=[10,10,1]
  if role:size=role[2]
  if c.get('side')=='bottom':z=4.2-size[2]
  # Envelopes use exact saved reference positions, without implying final routing.
  material='sensor_package' if role else ('ceramic' if ref.startswith('C') else 'chip')
  output['components'].append(dict(ref=ref,position=[round(x,3),round(y,3),round(z,3)],size=size,rotation=c.get('rotation',0),material=material,optional=optional))
  if role:
   output['sensors'].append(dict(id=ref,label=role[0],description=role[1],position=[round(x,3),round(y,3),round(z+size[2]+.3,3)],normal=[0,0,1],optional=optional))
 output['buttons'].sort(key=lambda b:b['x'])
 if sku=='max':
  # One product-level callout, while retaining all the physical bank envelopes.
  telemetry=next(sensor for sensor in output['sensors'] if sensor['id']=='U9')
  output['sensors']=[dict(telemetry,id='power-telemetry',label='20-channel power telemetry',description='Current and voltage monitoring for all twenty LED outputs. Five quad current-sense banks feed multiplexers and a shared ADC.',members=['U50','U51','U52','U53','U54','U9'])]
  for option in localization['options']:
   display=option['display'];x,y,z=display['position_mm'];size=display['size_mm']
   output['components'].append(dict(ref=option['ref'],position=[x,y,z],size=size,rotation=display['rotation_deg'],material='sensor_package',optional=True,placement_status='display-only concept'))
   output['sensors'].append(dict(id=option['id'],label=option['label'],description=option['description'],position=[x,y,z+size[2]+.3],normal=[0,0,1],optional=True,placement_status='display-only concept'))
  output['note']='Optional UWB / GNSS shown · module locations provisional.'
 else:output['note']='Saved board layout · component shapes simplified.'+(' Optional GNSS shown.' if sku=='splanc' else '')
path=R/'hardware/mechanical/advertising/board-details.json';path.write_text(json.dumps(result,separators=(',',':'))+'\n')
print({sku:{k:len(v) for k,v in p.items() if isinstance(v,list)} for sku,p in result['products'].items()})
