"""Independent saved-solid and system-budget checks for MAX r11."""
from pathlib import Path
import json,argparse,itertools
import cadquery as cq
ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=Path('output/max-service-r11'));R=ap.parse_args().source
D=json.loads((R/'design.json').read_text())['spec']['max'];E=json.loads(Path('hardware/splanc_max/service-system.json').read_text())
def rd(n):return cq.importers.importStep(str(R/'max'/(n+'.step')))
def volume(q):return q.val().Volume()
b,l=rd('base'),rd('lid');shell=b.union(l);checks={};failures=[]
def clear(n,a,b,tol=.01):
 v=volume(a.intersect(b));checks[n]=round(v,6)
 if v>tol:failures.append([n,v])
clear('shell halves',b,l)
for n in ['ethernet-panel-1','ethernet-panel-2','isolated-5V-SMPS','network-pcb-envelope','network-insulating-tray','dc-carrier','dc-carrier-clamp','power-service-tongue','Pi-ethernet-right-angle-plug-envelope','lv-pcb-envelope','active-cooler-envelope','usb-jumper-pcb-envelope','usb-male-A-envelope','usb-male-C-envelope','upstream-patch-envelope','downstream-patch-envelope','Pi-patch-envelope','DC-positive-harness-envelope','DC-return-harness-envelope','control-5V-harness-envelope']:
 clear(n+' / shell',rd(n),shell)
for n in ['network-RJ45-1-envelope','network-RJ45-2-envelope','network-RJ45-3-envelope']:
 clear(n+' / lid',rd(n),l)
clear('DC clamp / SMPS',rd('dc-carrier-clamp'),rd('isolated-5V-SMPS'))
clear('DC housing / SMPS',rd('XT150-positive-envelope'),rd('isolated-5V-SMPS'))
clear('network tray / SMPS',rd('network-insulating-tray'),rd('isolated-5V-SMPS'))
clear('Pi harness / HAT',rd('Pi-patch-envelope'),rd('lv-pcb-envelope'))
from build_clean_enclosures import box
# Closed exterior at both formerly exposed Pi ports.
for name,probe in [('Pi USB-C',box(328,35,9,1,8,7)),('Pi Ethernet',box(306,132,10,12,1,10))]:
 missing=volume(probe.cut(b));checks[name+' wall missing']=missing
 if missing>.001:failures.append([name+' wall missing',missing])
# Recompute ratings; never equate XT-series name with continuous amperage.
I=40+(E['dc']['control_power_budget_W']+E['dc']['LED_logic_budget_W'])/(E['dc']['minimum_design_voltage_V']*E['dc']['efficiency_budget'])
assert I<45<57
assert sum(E['control_supply']['budget_A'].values())*5.1<40
assert E['network']['physical_ports']==3 and E['network']['chip_integrated_PHY_ports']>=3
assert E['panel']['pi_exposure']==[] and E['control_supply']['pins']['2']!=E['control_supply']['pins']['5']
report={'revision':'max-service-r11','nominal_overlap_mm3':checks,'failures':failures,'worst_input_current_budget_A':I,'control_output_budget_W':sum(E['control_supply']['budget_A'].values())*5.1,'limitations':E['remaining_gates'],'network_status':E['network']['qualification']}
(R/'service-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));assert not failures,failures
