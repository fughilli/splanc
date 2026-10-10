from pathlib import Path
import json,html,hashlib,shutil
root=Path('output/capacity115')
summary=json.loads((root/'summary.json').read_text());sens=json.loads((root/'sensitivity.json').read_text());replay=json.loads((root/'hierarchical-replay.json').read_text())
g=json.loads(Path('output/fresh-pnr-20260919/overnight113-20260923/relocation/round-01/alternatives/candidate-00/evaluated-placed.json').read_text())
data=[json.loads((root/(r['name']+'.json')).read_text()) for r in summary['results']]
body='''<!doctype html><meta charset="utf-8"><title>Splanc capacity proxy calibration</title><style>body{background:#111722;color:#edf1f7;font:16px system-ui;margin:28px}select{padding:8px;margin:6px;background:#243246;color:white}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}section{background:#1b2534;padding:16px;border-radius:10px}svg{width:100%;background:#f7f8fa}table{border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #485569;text-align:right}p{max-width:1100px;line-height:1.5}.note{color:#ffc878}h1{font-size:26px}</style>
<h1>Placement capacity proxy — calibration, not routed-board results</h1>
<p>Shared multilayer channel and via demand, source electrical widths, power-array reservations and negotiated congestion. Blue outline: test array. Green: radio. All views use the same color scale: white = unused, amber = approaching capacity, red = at or above capacity. Hover for utilization. Geometry uses top-view coordinates.</p>
<p class="note">This model does not prove routability or electrical qualification. Coarse terminal and grid artifacts remain. No board was changed or routed for this benchmark. Actual under-radio routing had 57 opens but failed its preservation guard.</p>
<label>Layer <select id="layer"></select></label><main><section><select id="left"></select><div id="ls"></div><div id="lv"></div></section><section><select id="right"></select><div id="rs"></div><div id="rv"></div></section></main>
<h2>Default 2 mm model</h2><div id="scores"></div><h2>Grid-size sensitivity (lower score is better within each resolution)</h2><div id="sensitivity"></div><h2>Historical candidate replay</h2><div id="replay"></div>
<p>Hierarchical selection uses cheap width-weighted demand screening, representative opposite-side body opportunities and spatial diversity, then spends its bounded proxy budget. Exact DRC and full electrical routing remain the acceptance gate. Raw scores across different grid sizes are not comparable.</p><script>
'''
body+='const DATA='+json.dumps(data)+'; const GRAPH='+json.dumps(g)+'; const SENS='+json.dumps(sens)+'; const REPLAY='+json.dumps(replay)+';\n'
body+='''const $=id=>document.getElementById(id);let layers=DATA[0].layers;layers.forEach((l,i)=>$('layer').add(new Option(l,i)));DATA.forEach((d,i)=>['left','right'].forEach(id=>$(id).add(new Option(d.name,i))));$('right').value=2;
function draw(id,stat,index){let d=DATA[index],la=+$('layer').value,h=GRAPH.outline.height,w=GRAPH.outline.width,p=d.pitch_mm;let svg=`<svg viewBox="-2 -2 ${w+4} ${h+4}">`;
d.heatmap[la].forEach((row,y)=>row.forEach((v,x)=>{let t=Math.min(1,v),r=255,g=Math.round(255-170*t),b=Math.round(255-220*t);svg+=`<rect x="${x*p}" y="${h-(y+1)*p}" width="${p}" height="${p}" fill="rgb(${r},${g},${b})"><title>capacity utilization ${v.toFixed(2)}×</title></rect>`}));
GRAPH.components.forEach(c=>{let pos=c.ref==='TP1'?d.position:c.pos;let [cw,ch]=c.courtyard;if(Math.round(c.rot)%180===90)[cw,ch]=[ch,cw];svg+=`<rect x="${pos[0]-cw/2}" y="${h-pos[1]-ch/2}" width="${cw}" height="${ch}" fill="none" stroke="${c.ref==='TP1'?'#0354e8':c.ref==='U6'?'#087f35':'#536277'}" stroke-width="${['TP1','U6'].includes(c.ref)?.35:.07}"><title>${c.ref}: ${c.address}</title></rect>`;if(['TP1','U6'].includes(c.ref))svg+=`<text x="${pos[0]}" y="${h-pos[1]}" font-size="1.5">${c.ref}</text>`});svg+='</svg>';
$(id).innerHTML=svg;$(stat).textContent=`Overflow ${d.overflow_units.toFixed(2)} · saturation ${d.saturation.toFixed(2)} · coarse unreachable ${d.unreachable_branches} · ${d.seconds.toFixed(2)} s`}
function table(rows){return '<table>'+rows.map((r,i)=>'<tr>'+r.map(x=>`<${i?'td':'th'}>${x}</${i?'td':'th'}>`).join('')+'</tr>').join('')+'</table>'}
$('scores').innerHTML=table([['Placement','Score','Overflow','Saturation','Seconds'],...DATA.map(d=>[d.name,d.score.toFixed(1),d.overflow_units.toFixed(2),d.saturation.toFixed(2),d.seconds.toFixed(2)])]);
$('sensitivity').innerHTML=table([['Grid mm','Placement','Score','Coarse unreachable'],...SENS.map(d=>[d.pitch,d.name,d.score.toFixed(1),d.unreachable_branches])]);
$('replay').innerHTML=table([['Proxy rank','TP1 position','Score'],...REPLAY.candidates.slice().sort((a,b)=>a.score-b.score).map((d,i)=>[i+1,JSON.stringify(d.moves[0].position),d.score.toFixed(1)])]);
function update(){draw('lv','ls',+$('left').value);draw('rv','rs',+$('right').value)};['left','right','layer'].forEach(id=>$(id).onchange=update);update();</script>'''
(root/'index.html').write_text(body)
p=Path('output/mechanical-viewer/capacity115');p.mkdir(exist_ok=True);shutil.copy2(root/'index.html',p/'index.html')
files=[Path('hardware/pnr/pnr/place/capacity_proxy.py'),Path('hardware/pnr/pnr/place/batch_relocate.py')]
(root/'code-hashes.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2))
print('report ready')
