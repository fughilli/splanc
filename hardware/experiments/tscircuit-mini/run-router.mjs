import fs from 'node:fs';
import {AutoroutingPipelineSolver9_PreloadedTraceGraph as Router,AUTOROUTER_VERSION} from '@tscircuit/capacity-autorouter';
const [input,prefix,seconds='120']=process.argv.slice(2);
const srj=JSON.parse(fs.readFileSync(input,'utf8'));
// Keep the circuit and cache computations entirely local.
globalThis.fetch=async()=>{throw new Error('Network disabled for local routing experiment')};
const solver=new Router(srj,{cacheProvider:null,effort:1});
const start=performance.now();let lastPhase='',steps=0,lastLog=0,thrownError=null;
while(!solver.solved&&!solver.failed&&performance.now()-start<Number(seconds)*1000){
 try{solver.step();steps++;}catch(e){thrownError=String(e);break;}
 const phase=solver.getCurrentPhase();
 if(phase!==lastPhase||performance.now()-lastLog>15000){lastLog=performance.now();console.log(JSON.stringify({phase,seconds:(performance.now()-start)/1000,steps,progress:solver.computeProgress(),active:solver.activeSubSolver?.getSolverName?.()}));lastPhase=phase;}
}
const report={version:AUTOROUTER_VERSION,solved:solver.solved,failed:solver.failed||Boolean(thrownError),error:thrownError??solver.error,timedOut:!solver.solved&&!solver.failed&&!thrownError,seconds:(performance.now()-start)/1000,steps,phase:lastPhase,phaseTimes:solver.timeSpentOnPhase};
try{const output=solver.getOutputSimpleRouteJson();fs.writeFileSync(prefix+'.output.json',JSON.stringify(output,null,2));report.outputTraces=output.traces?.length;}catch(e){report.outputError=String(e);}
try{fs.writeFileSync(prefix+'.graphics.json',JSON.stringify(solver.visualize()));}catch(e){report.visualizationError=String(e);}
fs.writeFileSync(prefix+'.report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
