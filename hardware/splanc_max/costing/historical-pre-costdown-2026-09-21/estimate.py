#!/usr/bin/env python3
"""Reproducible concept BOM budget; allowances are deliberately not RFQ prices."""
import json,csv
from pathlib import Path
ROOT=Path(__file__).resolve().parent
rows=[]
def row(board,part,qty,unit,kind,source='',note='',low=None,high=None):
 rows.append(dict(board=board,part=part,quantity=qty,unit_usd=unit,extended_usd=round(qty*unit,5),basis=kind,source=source,note=note,low_unit_usd=unit*.8 if low is None else low,high_unit_usd=unit*1.3 if high is None else high))
L='LV';P='power';B='USB bridge';H='interboard hardware'
row(L,'GW1NR-LV9QN88PC6/I5',1,18.2529,'published100tier_carried_to1000','https://www.lcsc.com/product-image/C5799578.html','182 stock snapshot; quantity 1,000 RFQ required',16,24)
row(L,'W25Q32JVSSIQ',1,1.1546,'published300tier_carried_to1000','https://www.lcsc.com/de/product-detail/C179173.html','Conservative newest exposed tier applicable to 1,000; regional snapshots disagree',1,1.4)
row(L,'FT2232HL-REEL',1,10.4124,'published100tier_carried_to1000','https://www.lcsc.com/product-detail/usb%20converters_ftdi_ft2232hl-reel_C27882.html','Snapshot cached3months; RFQ needed',8,12)
row(L,'FPGA 1.2 V/3.3 V and USB 1.8 V regulation/support',1,2.5,'engineering_allowance',note='Regulators, inductors, local bulk and power sequencing')
row(L,'27 MHz FPGA and 12 MHz USB clocks',1,.6,'engineering_allowance')
row(L,'USB descriptor EEPROM completion reserve (not fitted)',1,.2,'engineering_allowance')
row(L,'HAT identification EEPROM completion reserve (not fitted)',1,.18,'engineering_allowance')
row(L,'USB C receptacle/CC plus ESD completion reserve',1,.9,'engineering_allowance')
row(L,'40-pin Pi female stacking header',1,1.2,'engineering_allowance')
row(L,'50-pin ribbon shrouded header',1,.6,'engineering_allowance')
row(L,'TXU0304PWR SPI level translator',1,.45,'engineering_allowance',note='Added during final circuit reconciliation')
row(L,'Decoupling/bias/JTAG/reset/LED/testpoints',1,1.5,'engineering_allowance',note='Concept passive package, not yet generated BOM')
row(P,'TPS1H100BQPWPRQ1',20,.82,'engineering_allowance_above_exposed_price','https://www.lcsc.com/fr/product-detail/power-distribution-switches_texas-instruments-tps1h100bqpwprq1_C475505.html','Listed1000tier0.4597 but42stock;20,000 required;0.82 budgeting assumption',.6,1.2)
row(P,'ISO7760FDWR',4,3,'engineering_allowance','https://www.digikey.com/en/products/detail/texas-instruments/ISO7760FDWR/7604341','No applicable 1,000 tier recovered; six forward channels; all four need RFQ',2,4.5)
row(P,'ISO7761FDWR',1,3,'engineering_allowance','https://www.ti.com/product/ISO7761','five forward / one reverse; CLK/MOSI/LATCH/CS0/CS1/MISO',2,4.5)
row(P,'AD7490BRUZ-REEL7',2,13.1418,'published100tier_carried_to1000','https://www.lcsc.com/product-detail/Analog-to-Digital-Converters-ADC_Analog-Devices-AD7490BRUZ-REEL7_C36884.html','2,000 required; 1,197 snapshot stock; lower quote not assumed',10,16)
row(P,'Reference and ADC input RC networks',1,1,'engineering_allowance')
row(P,'Latched enable shift registers/control decoding',1,.65,'engineering_allowance')
row(P,'R-78E5.0-0.5 and3.3Vlocal regulation/support',1,4,'engineering_allowance',note='12/24 V default; 5 V input needs bypass variant; module price allowance')
row(P,'3-way 5.08 mm pitch pluggable terminal pair',20,1.10,'engineering_allowance',note='Complete board header plus mating plug; MPN unselected',low=.7,high=1.8)
row(P,'Per-channel TVS/protection/capacitors/data series/ILIM/sense',20,.3,'engineering_allowance')
row(P,'Input fuse/fuseholder/reverse protection/TVS/bulk completion reserve (not fitted)',1,3,'engineering_allowance')
row(P,'50-pin ribbon shrouded header',1,.6,'engineering_allowance')
row(P,'Temperature/status/testpoint/control passives',1,.5,'engineering_allowance')
row(P,'Copper busbar 160 x 8 x 2 mm fabricated/plated',2,2.5,'engineering_allowance',note='45.9 g pair; holes/plating/installation not commodity copper price',low=1.5,high=4)
row(P,'M5 lug terminals/studs/insulators/fasteners',2,1,'engineering_allowance',note='40 A rating unqualified',low=.5,high=2)
row(B,'USB A male vertical PCB connector',1,.6,'engineering_allowance')
row(B,'USB C male vertical PCB connector',1,.65,'engineering_allowance')
row(B,'USB bridge CC/strap plus ESD completion reserve',1,.15,'engineering_allowance')
row(H,'50-conductor IDC ribbon cable assembly',1,1.45,'engineering_allowance')
row(H,'Board mounting screws and standoffs',1,1.2,'engineering_allowance')
# Midcase only; lower/upper values are budget scenarios, not statistical confidence intervals.
sub={b:round(sum(r['extended_usd'] for r in rows if r['board']==b),4) for b in (L,P,B,H)}
manufacturing={L:{'pcb':[2,3,4.5],'assembly_test':[2,3.5,5]},P:{'pcb':[5,7,10],'assembly_test':[5,7.5,11]},B:{'pcb':[.15,.3,.6],'assembly_test':[.2,.4,.8]}}
bom=[round(sum(r['quantity']*r[k] for r in rows),2) for k in ('low_unit_usd','unit_usd','high_unit_usd')]
fab=[round(sum(v[k][i] for v in manufacturing.values() for k in v),2) for i in range(3)]
summary={'date':'2026-09-21','currency':'USD','build_quantity':1000,'state':'concept_budget_not_supplier_quote','bom_subtotals':sub,'bom_per_set_low_mid_high':bom,'pcb_assembly_test_per_set_low_mid_high':fab,'pcba_set_low_mid_high':[round(bom[i]+fab[i],2) for i in range(3)],'pcb_assembly_test':manufacturing,'bom_mid_1000':round(bom[1]*1000,2),'procurement_allowance_3percent_mid':round(bom[1]*1030,2),'excludes':['Pi','microSD','power supplies','LED strips/cables','enclosure','freight','tax/duty','NRE','compliance','scrap/rework over3 percent']}
(ROOT/'bom.json').write_text(json.dumps({'summary':summary,'lines':rows},indent=2)+'\n')
with (ROOT/'bom.csv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
(ROOT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
