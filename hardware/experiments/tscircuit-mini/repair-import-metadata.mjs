import fs from 'node:fs';
import {CircuitJsonToKicadPcbConverter} from 'circuit-json-to-kicad';
const cj=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ports=new Map(cj.filter(x=>x.type==='source_port').map(x=>[x.source_port_id,x]));
for(const n of cj.filter(x=>x.type==='source_net'))n.subcircuit_connectivity_map_key=n.source_net_id;
let assigned=0;
for(const t of cj.filter(x=>x.type==='source_trace')){
 if(t.connected_source_net_ids?.length!==1)throw new Error('Ambiguous source net association');
 const key=t.connected_source_net_ids[0];t.subcircuit_connectivity_map_key=key;
 for(const id of t.connected_source_port_ids??[]){const p=ports.get(id);if(!p)throw new Error('Missing source port '+id);if(p.subcircuit_connectivity_map_key&&p.subcircuit_connectivity_map_key!==key)throw new Error('Conflicting net assignment');p.subcircuit_connectivity_map_key=key;assigned++;}
}
const exp=new CircuitJsonToKicadPcbConverter(cj);exp.runUntilFinished();fs.writeFileSync(process.argv[3],exp.getOutputString());console.log({assignedPorts:assigned});
