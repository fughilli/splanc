import fs from 'node:fs';
const srj=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const routes=JSON.parse(fs.readFileSync(process.argv[3],'utf8')).traces??[];
const b=srj.bounds,pad=.2,w=b.maxX-b.minX,h=b.maxY-b.minY;
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const svg=[`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1080" viewBox="${b.minX-pad} ${b.minY-pad} ${w+2*pad} ${h+2*pad}">`,`<rect x="${b.minX-pad}" y="${b.minY-pad}" width="${w+2*pad}" height="${h+2*pad}" fill="#111c28"/>`];
for(const o of srj.obstacles.filter(o=>o.layers.includes('top'))){const{x,y}=o.center;const color=o.connectedTo.includes('MODE')?'#ffd166':'#865f68';svg.push(`<rect x="${x-o.width/2}" y="${y-o.height/2}" width="${o.width}" height="${o.height}" transform="rotate(${o.ccwRotationDegrees??0} ${x} ${y})" fill="${color}"/>`);}
for(const trace of routes)for(let i=1;i<trace.route.length;i++){const p=trace.route[i-1],q=trace.route[i];if(p.route_type==='wire'&&q.route_type==='wire'&&p.layer===q.layer)svg.push(`<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#4ff0a7" stroke-width="${p.width}" stroke-linecap="round"/>`);}
for(const c of srj.connections)for(const p of c.pointsToConnect)svg.push(`<text x="${p.x}" y="${p.y-.25}" font-size=".22" fill="white" text-anchor="middle">${escape(c.name)}</text>`);
svg.push('</svg>');fs.writeFileSync(process.argv[4],svg.join('\n'));
