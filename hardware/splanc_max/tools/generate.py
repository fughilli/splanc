#!/usr/bin/env python3
"""Generate reviewed-input connectivity, atopile atoms and rough, UNROUTED PCBs.
No supplier claims: custom atoms are selected by MPN, footprints require final audit.
"""
from pathlib import Path
import json,re,shutil,sys
ROOT=Path(__file__).resolve().parents[1]
LIB=Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints')
parts={};boards={}
def part(key,mpn,n,foot,manufacturer='Design selection',extra=None):
 parts[key]=dict(mpn=mpn,pins=[str(i) for i in range(1,n+1)],footprint=foot,manufacturer=manufacturer);parts[key].update(extra or {});return key
def b(name,w,h,mounts):
 boards[name]=dict(outline=dict(width_mm=w,height_mm=h,thickness_mm=1.6),mounts=[dict(x=x,y=y,diameter_mm=2.7 if name=='lv' else 3.2) for x,y in mounts],connectors=[],components=[]);return boards[name]
def add(B,ref,key,x,y,nets,rotation=0):
 B['components'].append(dict(ref=ref,part=key,position=[x,y],rotation=rotation,nets={str(k):v for k,v in nets.items()}));return ref
def con(B,ref,xy,edge,opening,kind,z): B['connectors'].append(dict(ref=ref,position=xy,edge=edge,opening=opening,kind=kind,center_z_above_pcb_mm=z))
def passive(B,ref,value,x,y,a,z,cap=False):add(B,ref,'C' if cap else 'R',x,y,{1:a,2:z});B['components'][-1]['value']=value
part('R','0603 resistor, value per BOM',2,'Resistor_SMD:R_0603_1608Metric')
part('C','0603 capacitor, value/rating per BOM',2,'Capacitor_SMD:C_0603_1608Metric')
part('FPGA','GW1NR-LV9QN88PC6/I5',89,'custom:QN88', 'Gowin',dict(footprint_status='PROVISIONAL EP geometry: verify Gowin package drawing'))
part('FLASH','W25Q32JVSSIQ',8,'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm','Winbond')
part('USB','TYPE-C-31-M-12',0,'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12','HRO',dict(pins=['A1','A4','A5','A6','A7','A8','A9','A12','B1','B4','B5','B6','B7','B8','B9','B12','SH']))
part('PI','2x20 female HAT socket elevated18.4mm',40,'Connector_PinSocket_2.54mm:PinSocket_2x20_P2.54mm_Vertical')
part('RIBBON','2x25 keyed IDC 1.27mm',50,'custom:RIBBON',extra=dict(footprint_status='connector MPN/mechanical locking selection pending'))
part('FTDI','FT2232HL',64,'Package_QFP:LQFP-64_10x10mm_P0.5mm','FTDI')
part('OSC','27MHz CMOS3.3V oscillator',4,'Oscillator:Oscillator_SMD_Fox_FT5H_5.0x3.2mm')
part('XTAL','12MHz crystal 18pF',2,'Crystal:Crystal_SMD_5032-2Pin_5.0x3.2mm')
part('LDO','AP2112K-3.3TRG1',5,'Package_TO_SOT_SMD:SOT-23-5','Diodes')
part('LDO12','TLV75512PDBVR',5,'Package_TO_SOT_SMD:SOT-23-5','TI')
part('LDO18','TLV75518PDBVR',5,'Package_TO_SOT_SMD:SOT-23-5','TI')
part('SW','TPS1H100AQPWPRQ1',15,'Package_SO:Texas_HTSSOP-14-1EP_4.4x5mm_P0.65mm_EP3.4x5mm_Mask2.94x3.34mm','TI')
part('ISO','ISO7760FDWR',16,'Package_SO:SOIC-16W_7.5x10.3mm_P1.27mm','TI')
part('ISOSPI','ISO7761FDWR',16,'Package_SO:SOIC-16W_7.5x10.3mm_P1.27mm','TI')
part('SHIFT','SN74HC595PWR',16,'Package_SO:TSSOP-16_4.4x5mm_P0.65mm','TI')
part('ADC','MCP3208-CI/SL',16,'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm','Microchip')
part('CSA','INA4180A2IPWR',14,'Package_SO:TSSOP-14_4.4x5mm_P0.65mm','TI')
part('MUX','CD74HC4051PWR',16,'Package_SO:TSSOP-16_4.4x5mm_P0.65mm','TI')
part('SHUNT','PE2512FKE070R02L',2,'Resistor_SMD:R_2512_6332Metric','YAGEO',dict(resistance_ohm=.02,tolerance_percent=1,power_W=1,tcr_ppm_C=50))
part('REF','REF3025AIDBZR',3,'Package_TO_SOT_SMD:SOT-23','TI')
part('BUCK','R-78E5.0-0.5',3,'custom:BUCK','RECOM',dict(footprint_status='module envelope and pin pitch provisional,12/24Vdefault only'))
part('OUT','2EDGRC-5.08-03P-14-100A(H)',3,'custom:OUT','DEGSON',dict(mating_plug='2EDGKDF-5.08-03P-14-00A(H)',supplier_reference='LCSC C669315',mating_supplier_reference='LCSC C691852',footprint_status='Official DEGSON drawing dimensions; pad drill1.5mm; physical fit qualification pending'))
part('LUG','M5 bolted copper busbar terminal',1,'custom:LUG')
lv=b('lv',85,56,[(3.5,3.5),(61.5,3.5),(3.5,52.5),(61.5,52.5)])
pw=b('power',200,120,[(5,15),(195,15),(5,105),(195,105)])
# Pi header x first pin=7.1,y49; rows run east, keep cooler central aperture reserved.
pi={2:'PI_5V',4:'PI_5V',6:'DGND',9:'DGND',14:'DGND',20:'DGND',25:'DGND',30:'DGND',34:'DGND',39:'DGND',19:'PI_MOSI',21:'PI_MISO',23:'PI_SCLK',24:'PI_CS',18:'PI_IRQ'}
add(lv,'J1','PI',7.1,49,pi,90)
add(lv,'J2','USB',82.5,29.1,{'A1':'DGND','B1':'DGND','A12':'DGND','B12':'DGND','A4':'USB_VBUS','B4':'USB_VBUS','A9':'USB_VBUS','B9':'USB_VBUS','A6':'USB_DP','B6':'USB_DP','A7':'USB_DM','B7':'USB_DM','A5':'CC1','B5':'CC2','SH':'DGND'},90)
con(lv,'J2',[85,29.1],'east',[10,5],'usb_c',2)
passive(lv,'R1','5.1k',78,25,'CC1','DGND');passive(lv,'R2','5.1k',78,33,'CC2','DGND')
# Ribbon alternates 20data with grounds, then 5SPI +return and two supply returns.
rib={};
for i in range(20):rib[2*i+1]=f'DATA{i}';rib[2*i+2]='DGND'
for i,n in enumerate(['P_SCLK','P_MOSI','P_LATCH','P_CS0','P_CS1','P_MISO','LV3V3','DGND','SAFE_ENABLE','DGND'],41):rib[i]=n
add(lv,'J3','RIBBON',65,12,rib,90);con(lv,'J3',[65,12],'internal',[34,7],'ribbon50',4)
fp={p:'CORE1V2' for p in [1,22,45,66]};fp.update({p:'DGND' for p in [2,21,24,43,46,65,89]});fp.update({p:'LV3V3' for p in [23,44,58,64,67,78]});fp[12]='BANK1V8'
for i,p in enumerate([25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,47,48]):fp[p]=f'DATA{i}'
for p,n in {49:'PI_MOSI',50:'PI_MISO',51:'PI_SCLK',53:'PI_CS',54:'PI_IRQ',68:'P_SCLK',69:'P_MOSI',70:'P_LATCH',71:'P_CS0',72:'P_CS1',73:'P_MISO',74:'SAFE_ENABLE',59:'F_CLK',60:'F_CS',61:'F_MOSI',62:'F_MISO',52:'CLK27',5:'JTAG_TMS',6:'JTAG_TCK',7:'JTAG_TDI',8:'JTAG_TDO',9:'RECONFIG',4:'JTAGSEL',87:'MODE1',88:'MODE0'}.items():fp[p]=n
add(lv,'U1','FPGA',29,17,fp)
add(lv,'U2','FLASH',44,15,{1:'F_CS',2:'F_MISO',3:'LV3V3',4:'DGND',5:'F_MOSI',6:'F_CLK',7:'LV3V3',8:'LV3V3'})
for j,(n,v) in enumerate([('MODE0','BANK1V8'),('MODE1','DGND'),('JTAGSEL','DGND'),('RECONFIG','BANK1V8'),('F_CS','LV3V3')]):passive(lv,'R'+str(10+j),'10k',20+j*3,26,n,v)
add(lv,'Y1','OSC',42,23,{1:'LV3V3',2:'DGND',3:'CLK27',4:'LV3V3'})
# FTDI documented64pin mapping; JTAG connection 1.8Vbankrequires translation: left as explicit reservedblock below.
ft={p:'DGND' for p in [1,5,10,11,15,25,35,47,51]};ft.update({p:'LV3V3' for p in [4,9,20,31,42,50,56]});ft.update({p:'FT_CORE' for p in [12,37,64]});ft.update({6:'REFRES',7:'USB_DM',8:'USB_DP',2:'XTAL_IN',3:'XTAL_OUT',13:'DGND',14:'FT_RESET',49:'FT_CORE',16:'FT_TCK',17:'FT_TDI',18:'FT_TDO',19:'FT_TMS',38:'UART_TX',39:'UART_RX'})
add(lv,'U3','FTDI',59,31,ft);add(lv,'Y2','XTAL',50,36,{1:'XTAL_IN',2:'XTAL_OUT'})
passive(lv,'R22','10k',52,23,'LV3V3','FT_RESET');passive(lv,'C34','100nF',55,23,'FT_RESET','DGND',True)
passive(lv,'C35','18pF',48,39,'XTAL_IN','DGND',True);passive(lv,'C36','18pF',53,39,'XTAL_OUT','DGND',True)
passive(lv,'R20','12k1',52,28,'REFRES','DGND');passive(lv,'R21','10k',51,25,'USB_VBUS','USB_DETECT')
# Reserves for explicit level translators; nevershort1.8VJTAGto3.3VFTDI.
part('SHIFT4','TXU0304PWR',14,'Package_SO:TSSOP-14_4.4x5mm_P0.65mm','TI')
add(lv,'U4','SHIFT4',41,33,{1:'LV3V3',2:'FT_TCK',3:'FT_TDI',4:'FT_TMS',5:'FT_TDO',7:'DGND',8:'LV3V3',10:'JTAG_TDO',11:'JTAG_TMS',12:'JTAG_TDI',13:'JTAG_TCK',14:'BANK1V8'})
for ref,key,x,v in [('U5','LDO',9,'LV3V3'),('U6','LDO12',15,'CORE1V2'),('U7','LDO18',21,'BANK1V8')]:
 add(lv,ref,key,x,9,{1:'PI_5V' if ref=='U5' else 'LV3V3',2:'DGND',3:'PI_5V' if ref=='U5' else 'LV3V3',5:v})
for j in range(18):passive(lv,f'C{j+1}','100nF16V',9+(j%9)*4,37+(j//9)*3,'LV3V3' if j<9 else 'CORE1V2','DGND',True)
for j,n in enumerate(['LV3V3','CORE1V2','BANK1V8','FT_CORE']):passive(lv,f'C{30+j}','10uF10V',8+j*5,31,n,'DGND',True)
# Power side isolation barrier: LVribbon atwest, isolators span x43 barrier.
add(pw,'J1','RIBBON',28,60,rib);con(pw,'J1',[28,60],'internal',[7,34],'ribbon50',4)
add(pw,'J2','LUG',7,45,{1:'LED_VIN'});add(pw,'J3','LUG',7,75,{1:'PGND'})
con(pw,'J2',[0,45],'west',[13,13],'power_lug_positive',8);con(pw,'J3',[0,75],'west',[13,13],'power_lug_return',8)
for group in range(4):
 ns={1:'LV3V3',8:'DGND',9:'PGND',16:'P5V'}
 for k in range(6):ns[2+k]=f'DATA{group*6+k}' if group*6+k<20 else ('SAFE_ENABLE' if group*6+k==20 else 'DGND');ns[15-k]=f'ISO_DATA{group*6+k}' if group*6+k<20 else ('ISO_SAFE_ENABLE' if group*6+k==20 else f'UNUSED_ISO{group*6+k}')
 add(pw,f'U{group+1}','ISO',43,27+group*18,ns)
ns={1:'LV3V3',8:'DGND',9:'PGND',16:'P5V',7:'P_MISO',10:'ADC_MISO'}
for k,n in enumerate(['SCLK','MOSI','LATCH','CS0','CS1']):ns[2+k]='P_'+n;ns[15-k]='ISO_'+n
add(pw,'U5','ISOSPI',43,99,ns)
for g in range(3):
 ns={16:'P5V',8:'PGND',10:'P5V',13:'SHIFT_OE_N',11:'ISO_SCLK',12:'ISO_LATCH',14:'ISO_MOSI' if g==0 else f'SHIFT{g-1}',9:f'SHIFT{g}'}
 for i,p in enumerate([15,1,2,3,4,5,6,7]):ns[p]=f'EN{g*8+i}' if g*8+i<20 else (f'MUX_S{g*8+i-20}' if g*8+i<23 else 'UNUSED_SHIFT23')
 add(pw,f'U{6+g}','SHIFT',65+g*13,60,ns)
# Forty telemetry inputs: each 8:1 mux selects four currents and four voltages.
# Five ADC channels read the five four-channel groups. Unused former CS1 remains spare.
add(pw,'U9','ADC',123,60,{1:'MUX_OUT0',2:'MUX_OUT1',3:'MUX_OUT2',4:'MUX_OUT3',5:'MUX_OUT4',6:'REF2V5',7:'BUS_VMON',8:'FAULT_N',9:'PGND',10:'ISO_CS0',11:'ISO_MOSI',12:'ADC_MISO',13:'ISO_SCLK',14:'PGND',15:'P5V',16:'P5V'})
for g in range(5):
 ns={4:'P5V',11:'PGND'}
 for j,(out,plus,minus) in enumerate([(1,3,2),(7,5,6),(8,10,9),(14,12,13)]):
  i=g*4+j;ns.update({out:f'ISENSE_RAW{i}',plus:f'RETURN{i}',minus:'PGND'})
 add(pw,f'U{50+g}','CSA',68+g*23,43,ns)
 ns={3:f'MUX_OUT{g}',6:'PGND',7:'PGND',8:'PGND',16:'P5V',11:'MUX_S0',10:'MUX_S1',9:'MUX_S2'}
 for j,pin in enumerate([13,14,15,12,1,5,2,4]):ns[pin]=f'ISENSE{g*4+j}' if j<4 else f'VMON{g*4+j-4}'
 add(pw,f'U{60+g}','MUX',68+g*23,52,ns)
 passive(pw,f'C{100+g}','100nF16V',68+g*23,46,'P5V','PGND',True)
 passive(pw,f'C{105+g}','100nF16V',68+g*23,55,'P5V','PGND',True)
for i in range(3):passive(pw,f'R{100+i}','100k mux address pulldown',95+i*4,64,f'MUX_S{i}','PGND')
passive(pw,'R103','4.7k aggregate open-drain status pullup',144,64,'P5V','FAULT_N')
passive(pw,'R104','100k 0.1percent bus divider upper',150,65,'LED_VIN','BUS_VMON')
passive(pw,'R105','10k 0.1percent bus divider lower',155,65,'BUS_VMON','PGND')
passive(pw,'C110','10nF50V bus divider filter',160,65,'BUS_VMON','PGND',True)
passive(pw,'C111','1uF10V ADC supply',125,66,'P5V','PGND',True)
part('NPN','MMBT3904',3,'Package_TO_SOT_SMD:SOT-23','onsemi')
add(pw,'Q1','NPN',65,69,{1:'OE_BASE',2:'PGND',3:'SHIFT_OE_N'})
passive(pw,'R90','10k',69,69,'P5V','SHIFT_OE_N');passive(pw,'R91','10k',61,69,'ISO_SAFE_ENABLE','OE_BASE');passive(pw,'R92','100k',61,73,'OE_BASE','PGND')
add(pw,'U11','REF',105,70,{1:'P5V',2:'PGND',3:'REF2V5'});add(pw,'U12','BUCK',18,94,{1:'LED_VIN',2:'PGND',3:'P5V'})
for i in range(20):
 x=14.5+19*(i%10);north=i<10;y=9.9 if north else 110.1;sy=19 if north else 101
 # Design coordinates are lower-left/+Y up; STEP mouth is -Y at rotation0.
 # Native KiCad positions invert board Y below; pin1 remains electrical OUT.
 add(pw,f'J{i+10}','OUT',x+(-5.08 if north else 5.08),y,{1:f'OUT{i}',2:f'LED_DATA{i}',3:f'RETURN{i}'},0 if north else 180)
 con(pw,f'J{i+10}',[x,0 if north else 120],'south' if north else 'north',[18.1,13],'led_output3',4.3)
 add(pw,f'U{i+20}','SW',x,sy,{2:'PGND',3:f'EN{i}',5:f'OUT{i}',6:f'OUT{i}',7:f'OUT{i}',8:'LED_VIN',9:'LED_VIN',10:'LED_VIN',12:'P5V',13:f'CL{i}',14:'FAULT_N',15:'PGND'})
 passive(pw,f'R{i*4+1}','1.00k currentlimit nominal2.47A',x-4,sy+6*(1 if north else-1),f'CL{i}','PGND')
 add(pw,f'RS{i}','SHUNT',x,sy+8*(1 if north else-1),{1:f'RETURN{i}',2:'PGND'})
 passive(pw,f'RVH{i}','100k 0.1percent voltage divider upper',x-4,sy+11*(1 if north else-1),f'OUT{i}',f'VMON{i}')
 passive(pw,f'RVL{i}','10k 0.1percent voltage divider lower',x,sy+11*(1 if north else-1),f'VMON{i}','PGND')
 passive(pw,f'CV{i}','10nF50V voltage filter',x+4,sy+11*(1 if north else-1),f'VMON{i}','PGND',True)
 passive(pw,f'RI{i}','100R current filter',x-4,sy+15*(1 if north else-1),f'ISENSE_RAW{i}',f'ISENSE{i}')
 passive(pw,f'CI{i}','1nF16V current filter',x,sy+15*(1 if north else-1),f'ISENSE{i}','PGND',True)
 passive(pw,f'R{i*4+3}','100k pulldown',x+4,sy+6*(1 if north else-1),f'EN{i}','PGND')
 passive(pw,f'R{i*4+4}','100R series',x+4,sy-5*(1 if north else-1),f'ISO_DATA{i}',f'LED_DATA{i}')
 passive(pw,f'C{i+1}','100nF50V',x,sy-5*(1 if north else-1),f'OUT{i}','PGND',True)
for i in range(24):passive(pw,f'C{i+30}','100nF16V',60+(i%12)*8,75+(i//12)*4,'P5V','PGND',True)
# Separate vertical bridge accessory. Connector footprints remain concept envelopes.
part('USBAP','USB-A male vertical, MPN selection pending',5,'custom:USBAP',extra=dict(footprint_status='PROVISIONAL vertical male envelope; not an approved connector'))
part('USBCP','USB-C male vertical, MPN selection pending',6,'custom:USBCP',extra=dict(footprint_status='PROVISIONAL USB2 male envelope pinmap: VBUS,D-,D+,GND,CC,shield'))
br=b('usb_bridge',24,32,[])
add(br,'J1','USBAP',12,7,{1:'USB_VBUS',2:'USB_DM',3:'USB_DP',4:'USB_GND',5:'USB_GND'})
add(br,'J2','USBCP',12,25.4,{1:'USB_VBUS',2:'USB_DM',3:'USB_DP',4:'USB_GND',5:'CC',6:'USB_GND'})
passive(br,'R1','56k1%',5,22,'USB_VBUS','CC')
con(br,'J1',[12,7],'internal',[12.2,4.5],'usb_a_male_vertical',6)
con(br,'J2',[12,25.4],'internal',[8.4,2.6],'usb_c_male_vertical',6)
for j in range(5):passive(lv,f'C{40+j}','100nF16V',7+j*4,27,'BANK1V8' if j<2 else 'LV3V3','DGND',True)
for j in range(5):passive(pw,f'C{60+j}','100nF16V',36,27+j*16,'LV3V3','DGND',True)
passive(pw,'C70','10uF10V',22,100,'P5V','PGND',True)
passive(pw,'C71','1uF10V',105,74,'REF2V5','PGND',True)
interface={'schema':'splanc-mechanical-v1','units':'mm','status':'rough-unrouted-design-review-required','boards':{k:{x:v for x,v in B.items() if x!='components'} for k,B in boards.items()},'power':{'channels':20,'continuous_current_A_per_channel':2,'aggregate_current_A':40,'default_input_V':[12,24],'busbars':[{'net':'LED_VIN','x':13,'y':35,'length_mm':160,'width_mm':8,'thickness_mm':2},{'net':'PGND','x':13,'y':77,'length_mm':160,'width_mm':8,'thickness_mm':2}],'qualification':'thermal, protection, connector and current-sharing qualification pending'}}
(ROOT/'interface.json').write_text(json.dumps(interface,indent=2)+'\n')
(ROOT/'design.json').write_text(json.dumps(dict(parts=parts,boards=boards),indent=2)+'\n')
# Expand each passive value into its own atomic definition so source/BOM keep values.
for B in boards.values():
 for c in B['components']:
  if c['part'] in ('R','C'):
   key=c['part']+'_'+re.sub('[^A-Za-z0-9]', '_', c['value']);base=dict(parts[c['part']]);base['mpn']=c['value']+' '+c['part']+'0603 engineering specification';parts[key]=base;c['part']=key
(ROOT/'design.json').write_text(json.dumps(dict(parts=parts,boards=boards),indent=2)+'\n')
# Remove superseded generated atoms so deleted choices cannot be mistaken for active BOM.
for old in (ROOT/'elec/src/parts').iterdir():
 if old.is_dir() and old.name not in parts:shutil.rmtree(old)
# Atomic source outputs and generic symbols. Custom footprints are schematic placeholders explicitlyflagged.
for key,p in parts.items():
 d=ROOT/'elec/src/parts'/key;d.mkdir(parents=True,exist_ok=True)
 pins=p['pins'];foot=p['footprint'];fp=d/(key+'.kicad_mod')
 if not foot.startswith('custom:'):
  lib,name=foot.split(':');shutil.copyfile(LIB/(lib+'.pretty')/(name+'.kicad_mod'),fp);fp.write_text(re.sub(r'\(footprint \"[^\"]+\"', '(footprint \"'+key+'\"', fp.read_text(), count=1))
 else:
  pads=[];body=(8,8)
  if key=='FPGA':
   body=(10,10)
   for i in range(88):
    side=i//22;t=(i%22-10.5)*.4;px,py=[(-5,t),(t,5),(5,-t),(-t,-5)][side];pads.append(f'(pad "{i+1}" smd rect (at {px} {py}) (size {0.65 if side%2==0 else .22} {.22 if side%2==0 else .65}) (layers "F.Cu" "F.Paste" "F.Mask"))')
   pads.append('(pad "89" smd rect (at 0 0) (size 6.7 6.7) (layers "F.Cu" "F.Paste" "F.Mask"))')
  else:
   for j,n in enumerate(pins):
    if key=='RIBBON':px,py=(j%2-.5)*1.27,(j//2-12)*1.27;body=(6,35);size,drill=1,.65
    elif key=='OUT':px,py=j*5.08,0;body=(17.24,12);size,drill=2.7,1.5
    elif key in ('USBAP','USBCP'):px,py=(j-(len(pins)-1)/2)*1.0,0;body=(13 if key=='USBAP' else 9,5);size,drill=.8,.4
    elif key=='LUG':px=py=0;body=(12,12);size,drill=10,5.3
    else:px,py=(j-1)*2.54,0;body=(11.6,8.5);size,drill=2,1
    pads.append(f'(pad "{n}" thru_hole circle (at {px} {py}) (size {size} {size}) (drill {drill}) (layers "*.Cu" "*.Mask"))')
  w,h=body;fp.write_text(f'(footprint "{key}" (version 20241229) (generator "splanc_max") (layer "F.Cu") (property "Reference" "REF**" (at 0 {-h/2-1}) (layer "F.SilkS")) (property "Value" "{key}" (at 0 {h/2+1}) (layer "F.Fab")) (fp_rect (start {-w/2} {-h/2}) (end {w/2} {h/2}) (stroke(width 0.15)(type default))(fill none)(layer "F.SilkS")) '+''.join(pads)+')')
 if key=='OUT':
  # Official DEGSON 3-pole housing, pin1-origin; native +Y points toward mating face.
  # STEP uses right-handed board coordinates, so its front is -Y.
  fp.write_text('(footprint "OUT" (version 20241229) (generator "splanc_max") (layer "F.Cu") (property "Reference" "REF**" (at 5.08 -3.2) (layer "F.Fab")) (property "Value" "2EDGRC-5.08-03P-14-100A(H)" (at 5.08 11) (layer "F.Fab")) (fp_rect (start -3.54 -2.1) (end 13.7 9.9) (stroke (width 0.15) (type default)) (fill none) (layer "F.Fab")) '+''.join(pads)+' (model "${KIPRJMOD}/../elec/src/parts/OUT/degson-2edgrc-3-header-normalized.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))')
  model=ROOT.parent/'mechanical/assets/max-connectors/degson-2edgrc-3-header-normalized.step'
  if model.exists():shutil.copyfile(model,d/model.name)
  (d/'MODEL-PROVENANCE.md').write_text('Official DEGSON manufacturer 3-pole header CAD and drawing, downloaded for this design. Original assets and source retrieval are retained in hardware/mechanical/assets/max-connectors. Normalization: rotateX180 degrees then translate(-19.18,2.1,-1.4)mm; no scaling. Native footprint Y runs toward the mating face; STEP front is-Y. Manufacturer CAD remains subject to its original terms; no new license is asserted.\n')
 atom=f'import is_atomic_part\nimport has_part_picked\nimport has_designator_prefix\n\ncomponent {key}:\n    trait is_atomic_part<manufacturer="{p["manufacturer"]}", partnumber="{p["mpn"]}", footprint="{key}.kicad_mod", symbol="{key}.kicad_sym">\n    trait has_part_picked::by_supplier<supplier_id="manufacturer", supplier_partno="{p["mpn"]}", manufacturer="{p["manufacturer"]}", partno="{p["mpn"]}">\n    trait has_designator_prefix<prefix="U">\n'
 for n in pins:atom+=f'    signal p{n} ~ pin {n}\n'
 atom=atom.replace('supplier_id="manufacturer"', 'supplier_id=""').replace('supplier_partno="'+p['mpn']+'"', 'supplier_partno=""')
 (d/(key+'.ato')).write_text(atom)
 syms=[]
 for j,n in enumerate(pins):syms.append(f'(pin passive line (at -5 {j*2.54} 0)(length 2.54)(name "p{n}" (effects(font(size 1 1))))(number "{n}"(effects(font(size 1 1)))))')
 (d/(key+'.kicad_sym')).write_text(f'(kicad_symbol_lib(version 20241209)(generator "splanc_max")(symbol "{key}" (property "Reference" "U"(at 0 0 0)(effects(font(size 1 1))))(property "Value" "{key}"(at 0 2 0)(effects(font(size 1 1))))(symbol "{key}_1_1" '+''.join(syms)+')))')
for name,B in boards.items():
 text='\n'.join(f'from "parts/{k}/{k}.ato" import {k}' for k in sorted({c['part'] for c in B['components']}))+'\n\nmodule '+{'lv':'SplancMaxLV','power':'SplancMaxPower','usb_bridge':'SplancMaxUSBBridge'}[name]+':\n'
 nets=sorted({n for c in B['components'] for n in c['nets'].values()})
 for n in nets:text+=f'    signal {n}\n'
 for c in B['components']:
  text+=f'    {c["ref"]} = new {c["part"]}\n'
  for pin,n in c['nets'].items():text+=f'    {c["ref"]}.p{pin} ~ {n}\n'
 if name=='power':
  for i in range(20):
   for target,pads in [(f'U{i+20}',['5','6','7']),(f'U{i+20}',['8','9','10']),(f'J{i+10}',['1']),(f'J{i+10}',['3']),(f'RS{i}',['1','2'])]:
    text+='    # @pnr-current '+json.dumps(dict(target=target,pads=pads,scope='terminal',rms_current_a=2,peak_current_a=2.8,neck_max_length_mm=.5))+'\n'
   text+='    # @pnr-kelvin '+json.dumps(dict(shunt=f'RS{i}',positive_pad='1',negative_pad='2',sense_component=f'U{50+i//4}',sense_positive_pad=str([3,5,10,12][i%4]),sense_negative_pad=str([2,6,9,13][i%4]),avoid_shared_power_neck=True))+'\n'
  for target in ['J2','J3']:text+='    # @pnr-current '+json.dumps(dict(target=target,pads=['1'],scope='terminal',rms_current_a=40,peak_current_a=56))+'\n'
 (ROOT/f'elec/src/{name}.ato').write_text(text)
 fixed={f'@board.{c["ref"]}':{'at':c['position'],'rot':c['rotation'],'side':'top'} for c in B['components'] if c['ref'].startswith('J')}
 (ROOT/f'{name}-constraints.json').write_text(json.dumps({'schema':'v0','board':{'outline':{'w':B['outline']['width_mm'],'h':B['outline']['height_mm']},'layers':4},'fixed':fixed,'rough_placement':{c['ref']:c['position'] for c in B['components']}},indent=2))
(ROOT/'electrical-requirements.json').write_text(json.dumps({'schema':'splanc-max-requirements-v1','copper_oz':{'lv':1,'power':2},'max_temperature_rise_C':20,'channels':20,'per_channel_A':2,'aggregate_A':40,'notes':'No inferred ampacity qualification. Busbars must carry aggregate current, not a narrow PCB neck.','pairs':[{'board':'lv','positive':'USB_DP','negative':'USB_DM','differential_impedance_ohm':90,'max_skew_mm':.5,'coupled':True}],'isolation':{'domains':['DGND','PGND'],'minimum_copper_clearance_mm':3.2,'functional_only':True}},indent=2)+'\n')
(ROOT/'telemetry-config.json').write_text(json.dumps({'schema':'splanc-max-telemetry-v1','channels':20,'shunt_ohm':0.02,'gain_V_V':50,'current_full_scale_at_5V_A':5,'voltage_divider_ratio':11,'adc_reference':'P5V','reference_calibration_V':2.5,'adc_channels':{'0-4':'group g; mux0-3 current4g+a, mux4-7 voltage4g+a-4','5':'REF2V5','6':'BUS_VMON','7':'FAULT_N'},'mux_shift_bits':[20,21,22],'preserve_enable_bits':[0,19],'spi_hz':250000,'mux_settle_us':1000,'discard_first_conversion_after_channel_change':True,'initial_max_complete_scans_per_second':50,'kelvin_annotations_required':True,'output_voltage_correction':'V_OUT_to_PGND - I * shunt_ohm','measurement_bypass_risk':'Externally shared output returns bypass individual shunts; hardware high-side current limit remains active.'},indent=2)+'\n')
print('Generated design, interfaces, atopile sources and footprints')
if '--pcb' in sys.argv:
 import pcbnew as k
 for name,B in boards.items():
  board=k.BOARD();board.SetCopperLayerCount(4);nm={}
  for net in sorted({n for c in B['components'] for n in c['nets'].values()}):nm[net]=k.NETINFO_ITEM(board,net);board.Add(nm[net])
  for c in B['components']:
   f=k.FootprintLoad(str(ROOT/'elec/src/parts'/c['part']),c['part']);f.SetReference(c['ref']);f.SetValue(c.get('value',parts[c['part']]['mpn']));f.Value().SetVisible(False);f.Reference().SetLayer(k.F_Fab);board.Add(f);f.SetPosition(k.VECTOR2I(k.FromMM(c['position'][0]),k.FromMM(B['outline']['height_mm']-c['position'][1])));f.SetOrientationDegrees(c['rotation'])
   for g in f.GraphicalItems():
    if c['part'] in ('FPGA','USB','OUT') and g.GetLayer()==k.F_SilkS:g.SetLayer(k.F_Fab)
   for pad in f.Pads():
    if pad.GetNumber() in c['nets']:pad.SetNet(nm[c['nets'][pad.GetNumber()]])
  w,h=B['outline']['width_mm'],B['outline']['height_mm']
  for a,z in [((0,0),(w,0)),((w,0),(w,h)),((w,h),(0,h)),((0,h),(0,0))]:
   sh=k.PCB_SHAPE();sh.SetShape(k.SHAPE_T_SEGMENT);sh.SetLayer(k.Edge_Cuts);sh.SetStart(k.VECTOR2I(*[k.FromMM(v) for v in a]));sh.SetEnd(k.VECTOR2I(*[k.FromMM(v) for v in z]));sh.SetWidth(k.FromMM(.05));board.Add(sh)
  for i,m in enumerate(B['mounts']):
   f=k.FOOTPRINT(board);f.SetReference(f'H{i+1}');p=k.PAD(f);p.SetAttribute(k.PAD_ATTRIB_NPTH);p.SetShape(k.PAD_SHAPE_CIRCLE);p.SetSize(k.VECTOR2I(k.FromMM(m['diameter_mm']),k.FromMM(m['diameter_mm'])));p.SetDrillSize(p.GetSize());p.SetLayerSet(k.LSET.AllCuMask());f.Add(p);board.Add(f);f.SetPosition(k.VECTOR2I(k.FromMM(m['x']),k.FromMM(h-m['y'])))
  out=ROOT/'boards';out.mkdir(exist_ok=True);k.SaveBoard(str(out/f'splanc_max_{name}.kicad_pcb'),board)
  (out/f'splanc_max_{name}.kicad_pro').write_text(json.dumps({'board':{'design_settings':{'rules':{'min_clearance':0.15,'min_copper_edge_clearance':0.5}}},'net_settings':{'classes':[{'name':'Default','clearance':0.15,'track_width':0.25,'via_diameter':0.6,'via_drill':0.3}]},'meta':{'version':1}},indent=2)+'\n')
 print('Saved rough native boards; no routing; not fabrication output')
 import place
 place.run()
