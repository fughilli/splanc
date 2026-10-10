"""Small, electrically meaningful placement/routing regression inputs.

These are circuit/netlist fixtures, not preplaced or prerouted golden boards.
Pin numbering follows KiCad standard footprints and the named device datasheets.
"""
from copy import deepcopy

LIB = {
 'connector': 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
 'input': 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical',
 'resistor': 'Resistor_SMD:R_0805_2012Metric',
 'capacitor': 'Capacitor_SMD:C_0805_2012Metric',
 'led': 'LED_SMD:LED_0805_2012Metric',
 'timer': 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
 'counter': 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm',
 'inverter': 'Package_TO_SOT_SMD:SOT-23-5',
}

def part(ref, kind, value, nets):
 return dict(ref=ref, footprint=LIB[kind], value=value,
             pins={str(i+1): n for i,n in enumerate(nets)})

def circuit(name, description, parts, size, *, planes=False):
 # A supply connector is a real mechanical anchor; all other parts are movable.
 return dict(name=name, description=description, parts=parts,
  constraints=dict(schema='v0', board=dict(outline=dict(w=size[0],h=size[1]),layers=4 if planes else 2,
                     default_clearance_mm=.4,references_on_fab=True),
   fab=dict(track_width_mm=.25,clearance_mm=.2,via_diameter_mm=.6,via_drill_mm=.3,
            hole_clearance_mm=.25,edge_clearance_mm=.3,min_through_drill_mm=.3,via_annular_mm=.15),
   fixed={'J1':dict(at=[4,size[1]/2],rot=0,side='top')},
   net_class={'supply':dict(nets=['VCC'],width_mm=.4,current_a=.1,copper_oz=1,delta_t_c=10),
              'return':dict(nets=['GND'],width_mm=.4,**({'plane_layer':'In1.Cu'} if planes else {}))}),
  expected_components=len(parts), expected_connected_pads=sum(bool(n) for p in parts for n in p['pins'].values()),
  supply=dict(voltage_v=5,max_current_a=.1), layer_mode='ground_plane' if planes else 'routed_return')

def timer_parts():
 return [part('J1','connector','5V input',['VCC','GND']),
  part('U1','timer','TLC555',['GND','TIMING','CLOCK','VCC','CONTROL','TIMING','DISCHARGE','VCC']),
  part('R1','resistor','10k',['VCC','DISCHARGE']),part('R2','resistor','100k',['DISCHARGE','TIMING']),
  part('C1','capacitor','4.7u',['TIMING','GND']),part('C2','capacitor','10n',['CONTROL','GND']),
  part('C3','capacitor','100n',['VCC','GND'])]

def chaser(count, *, planes=False):
 p=timer_parts()
 # CD4017 pin1..16: Q5,Q1,Q0,Q2,Q6,Q7,Q3,GND,Q8,Q4,Q9,CO,CE,CLK,RESET,VDD.
 # Reset on Q[count] makes a count-stage one-hot LED sequence.
 qpins={0:3,1:2,2:4,3:7,4:10,5:1,6:5,7:6,8:9,9:11}
 pins=['']*16
 for i in range(count):pins[qpins[i]-1]='Q'+str(i)
 pins[qpins[count]-1]='RESET'
 for pin,net in {8:'GND',13:'GND',14:'CLOCK',15:'RESET',16:'VCC'}.items():pins[pin-1]=net
 p.append(part('U2','counter','CD4017B',pins))
 p.extend([part('C4','capacitor','100n',['VCC','GND']),part('C5','capacitor','10u',['VCC','GND'])])
 for i in range(count):
  p += [part('R'+str(i+3),'resistor','2.2k',['Q'+str(i),'LED'+str(i)]),
        part('D'+str(i+1),'led','red',['GND','LED'+str(i)])]
 return circuit(('07' if planes else '06' if count==5 else '05')+'-chaser-'+str(len(p))+('-plane' if planes else ''),
   'TLC555 clock + CD4017B modulo-%d LED chaser; unused counter outputs intentionally NC.'%count,p,(42,32) if count==5 else (36,28),planes=planes)

def designs():
 p=[part('J1','connector','Externally current-limited input',['LED_A','GND']),part('D1','led','red',['GND','LED_A'])]
 out=[circuit('01-connector-led-2','Two parts, external 2mA current source required (no omitted onboard resistor).',p,(18,14))]
 p=[part('J1','connector','5V input',['VCC','GND']),part('R1','resistor','1k',['VCC','LED_A']),part('D1','led','red',['GND','LED_A'])]
 out.append(circuit('02-resistor-led-3','Current-limited LED with movable resistor and LED.',p,(20,16)))
 p=p+[part('R2','resistor','1k',['VCC','LED_B']),part('D2','led','red',['GND','LED_B'])]
 out.append(circuit('03-branched-leds-5','Two independent LED loads sharing supply and return.',p,(24,18)))
 p=[part('J1','input','3.3V, GND, input',['VCC','GND','INPUT']),
    part('U1','inverter','SN74LVC1G04',['','INPUT','GND','OUTPUT','VCC']),
    part('C1','capacitor','100n',['VCC','GND']),part('C2','capacitor','1u',['VCC','GND']),
    part('R1','resistor','2.2k',['VCC','LED_A']),part('D1','led','red',['OUTPUT','LED_A']),
    part('R2','resistor','2.2k',['OUTPUT','LED_B']),part('D2','led','red',['GND','LED_B'])]
 out.append(circuit('04-inverter-leds-8','Logic-controlled complementary LED indicators and bypass capacitors.',p,(26,20)))
 out[-1]['supply']['voltage_v']=3.3
 p=timer_parts()+[part('R3','resistor','2.2k',['CLOCK','LED_A']),part('D1','led','red',['GND','LED_A']),part('C4','capacitor','10u',['VCC','GND'])]
 # Keep stable numerical ordering as complexity grows.
 t=circuit('05-timer-led-10','TLC555 astable LED blinker with timing, control and supply capacitors.',p,(30,24))
 out.append(t)
 small=chaser(2);small['name']='06-chaser-14';out.append(small)
 large=chaser(5);large['name']='07-chaser-20';out.append(large)
 plane=chaser(5,planes=True);plane['name']='08-chaser-20-plane';out.append(plane)
 return deepcopy(out)
