#!/usr/bin/env python3
"""Generate new P4/UWB/GNSS sources without modifying frozen Mini inputs."""
from pathlib import Path
import json,re,shutil
R=Path(__file__).resolve().parents[1];S=R/'elec/src';LIB=Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints')
def atom(key,mpn,n,foot,custom=None):
 d=S/'parts'/key;d.mkdir(exist_ok=True)
 if custom:(d/f'{key}.kicad_mod').write_text(re.sub(r'(?<=[ (])\.(\d)', r'0.\1', custom))
 else:
  lib,fn=foot.split(':');txt=(LIB/(lib+'.pretty')/(fn+'.kicad_mod')).read_text();txt=re.sub(r'\(footprint "[^"]+"',f'(footprint "{key}"',txt,count=1);(d/f'{key}.kicad_mod').write_text(txt)
 t=f'import has_designator_prefix\nimport has_part_picked\nimport is_atomic_part\n\ncomponent {key}:\n    trait is_atomic_part<manufacturer="Engineering selection", partnumber="{mpn}", footprint="{key}.kicad_mod", symbol="{key}.kicad_sym">\n    trait has_part_picked::by_supplier<supplier_id="", supplier_partno="", manufacturer="Engineering selection", partno="{mpn}">\n    trait has_designator_prefix<prefix="U">\n'
 for p in range(1,n+1):t+=f'    signal p{p} ~ pin {p}\n'
 (d/f'{key}.ato').write_text(t)
 pins=''.join(f'(pin passive line(at -5 {i*2.54} 0)(length 2.54)(name "p{i}"(effects(font(size 1 1))))(number "{i}"(effects(font(size 1 1)))))' for i in range(1,n+1))
 (d/f'{key}.kicad_sym').write_text(f'(kicad_symbol_lib(version 20241209)(generator "splanc")(symbol "{key}"(property "Reference" "U"(at 0 0 0)(effects(font(size 1 1))))(property "Value" "{key}"(at 0 2 0)(effects(font(size 1 1))))(symbol "{key}_1_1"{pins})))')
def custom(key,w,h,pads):return f'(footprint "{key}"(version 20241229)(generator "splanc")(layer "F.Cu")(property "Reference" "REF**"(at 0 {-h/2-1})(layer "F.Fab"))(property "Value" "{key}"(at 0 {h/2+1})(layer "F.Fab"))(fp_rect(start {-w/2} {-h/2})(end {w/2} {h/2})(stroke(width .1)(type default))(fill none)(layer "F.Fab"))'+''.join(pads)+')'
pads=[]
for i in range(104):
 side=i//26;t=(i%26-12.5)*.35;x,y=[(-5,t),(t,5),(5,-t),(-t,-5)][side];pads.append(f'(pad "{i+1}" smd rect(at {x} {y})(size {.6 if side%2==0 else .18} {.18 if side%2==0 else .6})(layers "F.Cu" "F.Paste" "F.Mask"))')
pads.append('(pad "105" smd rect(at 0 0)(size 8.1 8.1)(layers "F.Cu" "F.Paste" "F.Mask"))')
atom('ESP32P4','ESP32-P4NRW32X rev3.x',105,None,custom('ESP32P4',10,10,pads))
atom('DWM3000','DWM3000TR13',24,'RF_Module:DWM1000')
pads=[]
for i in range(18):
 side=i//9;x=(-1 if side==0 else 1)*4.85;y=(i%9-4)*1.1*(-1 if side else 1);pads.append(f'(pad "{i+1}" smd rect(at {x} {y})(size 1.1 .65)(layers "F.Cu" "F.Paste" "F.Mask"))')
atom('MAXM10S','MAX-M10S-00B',18,None,custom('MAXM10S',9.7,10,pads))
atom('QSPI','W25Q128JVSIQ',8,'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')
atom('R499K','499k 1% 0603',2,'Resistor_SMD:R_0603_1608Metric')
atom('C22P','22pF C0G 0603',2,'Capacitor_SMD:C_0603_1608Metric')
atom('L2U2','2.2uH shielded Isat>=3A',2,'Inductor_SMD:L_Abracon_ASPI-0425')
atom('XTAL40','40MHz crystal CL10pF',4,'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm')
atom('C6DEBUG','1x06 P2.54 debug header',6,'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical')
atom('UFL','U.FL-R-SMT-1(10)',2,'Connector_Coaxial:U.FL_Hirose_U.FL-R-SMT-1_Vertical')
atom('L27N','27nH RF choke 0603',2,'Inductor_SMD:L_0603_1608Metric')
imports=['from "parts/'+k+'/'+k+'.ato" import '+k for k in ['ESP32P4','DWM3000','QSPI','R499K','C22P','L2U2','XTAL40','C6DEBUG']]
imports+=['from "passives.ato" import '+k for k in ['C100n','C1u','C10u','C22u','C4u7','C10n','R10k','R100k','R0']]
imports+=['from "parts/Espressif_Systems_ESP32_C6_WROOM_1_N8/Espressif_Systems_ESP32_C6_WROOM_1_N8.ato" import Espressif_Systems_ESP32_C6_WROOM_1_N8_package','from "parts/Texas_Instruments_TLV62569DBVR/Texas_Instruments_TLV62569DBVR.ato" import Texas_Instruments_TLV62569DBVR_package']
t='\n'.join(imports)+'\n\nmodule P4Host:\n    p4 = new ESP32P4\n    signal P3V3\n    signal GND ~ p4.p105\n    signal EN ~ p4.p103\n    signal CORE\n    signal PSRAM\n    signal FLASHV\n'
gpio={0:104,**{i:i for i in range(1,9)},**{i:i+1 for i in range(9,20)},**{i:i+2 for i in range(20,24)},24:52,25:53,26:55,27:56,28:57,29:58,30:60,31:61,32:63,33:64,34:65,35:66,36:68,37:69,38:70,39:80,40:81,41:82,42:83,43:84,44:86,45:87,46:88,47:89,48:90,49:92,50:93,51:94,52:95,53:97,54:98}
legacy={i:gpio[i] for i in [0,1,2,3,4,5,6,7,10,18,19,20,21,22,23]};legacy.update({2:gpio[11],3:gpio[12],4:gpio[13],5:gpio[14],8:gpio[36],9:gpio[35],12:49,13:50})
for n,p in legacy.items():t+=f'    signal IO{n} ~ p4.p{p}\n'
t+='    signal TXD0 ~ p4.p69\n    signal RXD0 ~ p4.p70\n'
for pin in [9,21,51,62,75,77,85,96,101,102]:t+=f'    p4.p{pin} ~ P3V3\n'
for pin in [26,54,76,91]:t+=f'    p4.p{pin} ~ CORE\n'
for pin in [59,67,72]:t+=f'    p4.p{pin} ~ PSRAM\n'
t+='    p4.p71 ~ FLASHV\n    p4.p30 ~ FLASHV\n'
t+='    core_buck = new Texas_Instruments_TLV62569DBVR_package\n    core_buck.VIN ~ P3V3\n    core_buck.GND ~ GND\n    core_buck.EN ~ p4.p79\n    core_buck.FB ~ p4.p78\n    core_l = new L2U2\n    core_l.p1 ~ core_buck.SW\n    core_l.p2 ~ CORE\n    core_rtop = new R499K\n    core_rtop.p1 ~ CORE\n    core_rtop.p2 ~ core_buck.FB\n    core_rbottom = new R499K\n    core_rbottom.p1 ~ core_buck.FB\n    core_rbottom.p2 ~ GND\n    core_cff = new C22P\n    core_cff.p1 ~ CORE\n    core_cff.p2 ~ core_buck.FB\n'
for name,kind,net in [('core_in','C4u7','P3V3'),('core_out','C22u','CORE'),('flash_dec','C1u','FLASHV'),('psram_dec','C1u','PSRAM'),('input_bulk','C10u','P3V3'),('usb_4u7','C4u7','P3V3'),('usb_10n','C10n','P3V3')]+[(f'dec{i}','C100n',net) for i,net in enumerate(['P3V3']*10+['CORE']*4+['PSRAM']*2+['FLASHV'])]:
 t+=f'    {name} = new {kind}\n    {name}.p1 ~ {net}\n    {name}.p2 ~ GND\n'
t+='    flash = new QSPI\n'
for pin,net in {1:'p4.p27',2:'p4.p28',3:'p4.p29',4:'GND',5:'p4.p33',6:'p4.p32',7:'p4.p31',8:'FLASHV'}.items():t+=f'    flash.p{pin} ~ {net}\n'
t+='    xtal = new XTAL40\n    xtal.p1 ~ p4.p100\n    xtal.p3 ~ p4.p99\n    xtal.p2 ~ GND\n    xtal.p4 ~ GND\n'
for i,p in enumerate([99,100]):t+=f'    xtal_c{i} = new C22P\n    xtal_c{i}.p1 ~ p4.p{p}\n    xtal_c{i}.p2 ~ GND\n'
t+='    wireless = new Espressif_Systems_ESP32_C6_WROOM_1_N8_package\n    wireless.P3V3 ~ P3V3\n    wireless.GND ~ GND\n'
for p,c6 in [(57,'IO10'),(58,'IO11'),(60,'IO18'),(61,'IO19'),(63,'IO20'),(64,'IO21')]:t+=f'    p4.p{p} ~ wireless.{c6}\n'
for n in ['EN','IO8','IO9']:
 t+=f'    radio_pu_{n} = new R10k\n    radio_pu_{n}.p1 ~ P3V3\n    radio_pu_{n}.p2 ~ wireless.{n}\n'
t+='    c6_debug = new C6DEBUG\n    c6_debug.p1 ~ P3V3\n    c6_debug.p2 ~ GND\n    c6_debug.p3 ~ wireless.TXD0\n    c6_debug.p4 ~ wireless.RXD0\n    c6_debug.p5 ~ wireless.EN\n    c6_debug.p6 ~ wireless.IO9\n'
t+='    radio_reset = new C1u\n    radio_reset.p1 ~ wireless.EN\n    radio_reset.p2 ~ GND\n'
t+='    uwb = new DWM3000\n'
for p,n in {2:'GND',3:'p4.p84',5:'P3V3',6:'P3V3',7:'P3V3',8:'GND',16:'GND',17:'p4.p80',18:'p4.p81',19:'p4.p82',20:'p4.p83',21:'GND',22:'p4.p86',23:'GND',24:'GND'}.items():t+=f'    uwb.p{p} ~ {n}\n'
for name,kind,net in [('uwb_bulk','C10u','P3V3'),('uwb_dec','C100n','P3V3'),('uwb_irq_pd','R100k','uwb.p22')]:t+=f'    {name} = new {kind}\n    {name}.p1 ~ {net}\n    {name}.p2 ~ GND\n'
t+='    signal GPS_TX ~ p4.p87\n    signal GPS_RX ~ p4.p88\n    signal GPS_PPS ~ p4.p89\n    signal GPS_RESET ~ p4.p90\n'
t+='    # @pnr-current '+json.dumps({'target':'p4','pads':['9','21','51','62','75','77','85','96','101','102'],'scope':'terminal','rms_current_a':0.6,'peak_current_a':0.9})+'\n'
(S/'p4_host.ato').write_text(t)
t='\n'.join(['from "parts/'+k+'/'+k+'.ato" import '+k for k in ['MAXM10S','UFL','L27N']]+['from "passives.ato" import '+k for k in ['C100n','C10n','C10u','R10','R10k']])+'\n\nmodule GNSS:\n    signal P3V3\n    signal GND\n    signal TX\n    signal RX\n    signal PPS\n    signal RESET\n    gnss = new MAXM10S\n'
for p,n in {1:'GND',2:'RX',3:'TX',4:'PPS',6:'P3V3',7:'P3V3',8:'P3V3',9:'RESET',10:'GND',12:'GND'}.items():t+=f'    gnss.p{p} ~ {n}\n'
t+='    antenna = new UFL\n    antenna.p2 ~ GND\n    dc_block = new C10n\n    dc_block.p1 ~ gnss.p11\n    dc_block.p2 ~ antenna.p1\n    bias = new L27N\n    bias.p1 ~ antenna.p1\n    bias.p2 ~ gnss.p14\n    bulk = new C10u\n    bulk.p1 ~ P3V3\n    bulk.p2 ~ GND\n    dec = new C100n\n    dec.p1 ~ P3V3\n    dec.p2 ~ GND\n    reset_pu = new R10k\n    reset_pu.p1 ~ P3V3\n    reset_pu.p2 ~ RESET\n'
(S/'gnss.ato').write_text(t)
p=S/'splanc.ato';t=p.read_text();t=t.split('\nfrom "gnss.ato"')[0];t+='\nfrom "gnss.ato" import GNSS\n\nmodule SplancGPS:\n    board = new SplancCore\n    gps = new GNSS\n    gps.P3V3 ~ board.p3v3a.hv\n    gps.GND ~ board.p3v3a.lv\n    gps.TX ~ board.esp.GPS_TX\n    gps.RX ~ board.esp.GPS_RX\n    gps.PPS ~ board.esp.GPS_PPS\n    gps.RESET ~ board.esp.GPS_RESET\n';p.write_text(t)
interface={'schema':'splanc-mechanical-v1','units':'mm','coordinate_system':'lower-left origin, x right, y north/rear','status':'engineering-draft-unrouted','boards':{'splanc':{'outline':{'width_mm':100,'height_mm':80,'thickness_mm':1.6},'mounts':[dict(x=x,y=y,diameter_mm=2.7) for x,y in [(4,4),(96,4),(4,76),(96,76)]],'connectors':[{'ref':'board.usbc','position':[18,0],'edge':'south','opening':[10,4.5],'center_z_above_pcb_mm':1.5,'kind':'usb_c'},{'ref':'board.led0.conn','position':[94,25],'edge':'top','opening':[9,7],'center_z_above_pcb_mm':5.9,'kind':'jst_ph3_vertical'},{'ref':'board.led1.conn','position':[94,36],'edge':'top','opening':[9,7],'center_z_above_pcb_mm':5.9,'kind':'jst_ph3_vertical'}],'buttons':[{'ref':'board.btn_user1','position':[82,3.5]},{'ref':'board.btn_user2','position':[89,3.5]},{'ref':'board.btn_boot','position':[44,3.5]},{'ref':'board.btn_reset','position':[32,3.5]}],'indicators':[{'ref':'board.power_led','position':[27,10]},{'ref':'board.status_led','position':[33,10]}],'microphone':{'ref':'board.mic','position':[90,55],'acoustic_port':'bottom'},'antenna_keepouts':[{'ref':'board.esp.wireless','rectangle':[5,64,30,80]},{'ref':'board.esp.uwb','rectangle':[62,66,90,80]}],'optional_gnss':{'module':'MAX-M10S-00B','position':[48,57],'antenna_connector':[49,68],'antenna_mpn':'Taoglas AP.25F.07.0078A','antenna_envelope_mm':[25,25,8],'antenna_position_xy':[48,47],'cable_length_mm':78,'mounting':'lid internal, facing outward'}}}}
(R/'interface.json').write_text(json.dumps(interface,indent=2)+'\n')
print('Generated P4, UWB, optional GNSS sources and interface')
