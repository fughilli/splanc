import fs from 'node:fs';
import {getSimpleRouteJsonFromCircuitJson} from 'tscircuit';
const cj=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {simpleRouteJson}=getSimpleRouteJsonFromCircuitJson({circuitJson:cj,minTraceWidth:.2,nominalTraceWidth:.2,minTraceToPadEdgeClearance:.15,minViaEdgeToPadEdgeClearance:.15,minViaHoleEdgeToViaHoleEdgeClearance:.2,minPlatedHoleDrillEdgeToDrillEdgeClearance:.2,minPadEdgeToPadEdgeClearance:.15,minBoardEdgeClearance:.2,minViaHoleDiameter:.3,minViaPadDiameter:.6});
fs.writeFileSync(process.argv[3],JSON.stringify(simpleRouteJson,null,2));
console.log(JSON.stringify({connections:simpleRouteJson.connections.length,obstacles:simpleRouteJson.obstacles.length,traces:simpleRouteJson.traces?.length,layers:simpleRouteJson.layerCount,firstConnections:simpleRouteJson.connections.slice(0,2)},null,2));
