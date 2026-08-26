#!/usr/bin/env python3
"""waveform_server — live Plotly viewer for la_probe .sr captures.

A tiny stdlib HTTP server that reads the sigrok `.sr` sessions la_probe drops in
`.hostdeploy/` (shared with the host) and renders each logic channel as a digital
step trace via Plotly. Captures are bursty (a few hundred edges per channel), so
the whole edge list is sent and Plotly handles pan/zoom natively. The page
auto-refreshes to the newest capture, so new la_probe runs show up live.

    python3 pi/tools/la_probe/waveform_server.py [--dir .hostdeploy] [--port 8091]

Exposed as a named container service (see .claude-container-overlay/overlay.json):
    http://waveforms.$CLAUDE_SERVICE_INSTANCE.claude.localhost/
"""

from __future__ import annotations

import argparse
import json
import os
import re
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DIR = ".hostdeploy"
_CACHE: dict = {}  # path -> (mtime, parsed)


def _load_sr(path: str) -> dict:
    """Parse a .sr: samplerate, channel names, and per-channel edge lists
    [(sample, level), …]. Cached by mtime (edge lists are small)."""
    mtime = os.path.getmtime(path)
    hit = _CACHE.get(path)
    if hit and hit[0] == mtime:
        return hit[1]

    z = zipfile.ZipFile(path)
    meta = z.read("metadata").decode(errors="replace")
    hz = 0
    m = re.search(r"samplerate\s*=\s*([\d.]+)\s*([kMG]?)", meta)
    if m:
        mult = {"": 1, "k": 1e3, "M": 1e6, "G": 1e9}[m.group(2)]
        hz = int(float(m.group(1)) * mult)
    unitsize = 1
    mu = re.search(r"unitsize\s*=\s*(\d+)", meta)
    if mu:
        unitsize = int(mu.group(1))
    names = {}
    for pm in re.finditer(r"probe(\d+)\s*=\s*(\S+)", meta):
        names[int(pm.group(1)) - 1] = pm.group(2)
    nchan = max(names) + 1 if names else 8

    logic = b"".join(z.read(n) for n in sorted(z.namelist()) if n.startswith("logic-"))
    nsamp = len(logic) // unitsize

    def word(i: int) -> int:
        if unitsize == 1:
            return logic[i]
        base = i * unitsize
        return int.from_bytes(logic[base : base + unitsize], "little")

    # One pass: per-channel transition list.
    edges: dict = {c: [] for c in range(nchan)}
    prev = None
    for i in range(nsamp):
        w = word(i)
        if prev is None:
            for c in range(nchan):
                edges[c].append((i, (w >> c) & 1))
        else:
            diff = w ^ prev
            if diff:
                for c in range(nchan):
                    if (diff >> c) & 1:
                        edges[c].append((i, (w >> c) & 1))
        prev = w
    parsed = {
        "hz": hz,
        "nsamp": nsamp,
        "nchan": nchan,
        "names": {c: names.get(c, f"D{c}") for c in range(nchan)},
        "edges": edges,
        "dur_us": (nsamp / hz * 1e6) if hz else 0,
    }
    _CACHE[path] = (mtime, parsed)
    return parsed


def _sr_files(directory: str) -> list:
    out = []
    for f in sorted(os.listdir(directory)):
        if f.endswith(".sr"):
            p = os.path.join(directory, f)
            out.append({"name": f, "mtime": os.path.getmtime(p)})
    out.sort(key=lambda d: d["mtime"], reverse=True)
    return out


def _wave_json(directory: str, name: str, chans: list, max_pts: int) -> dict:
    path = os.path.join(directory, name)
    p = _load_sr(path)
    hz = p["hz"] or 1
    traces = []
    for c in chans:
        if c not in p["edges"]:
            continue
        es = p["edges"][c]
        truncated = len(es) > max_pts
        es = es[:max_pts]
        xs = [s / hz * 1e6 for s, _ in es]  # microseconds
        ys = [lv for _, lv in es]
        if es and es[-1][0] < p["nsamp"] - 1:  # extend last level to capture end
            xs.append(p["nsamp"] / hz * 1e6)
            ys.append(es[-1][1])
        traces.append(
            {
                "chan": c,
                "name": p["names"][c],
                "x": xs,
                "y": ys,
                "edges": len(es),
                "truncated": truncated,
            }
        )
    return {
        "name": name,
        "hz": hz,
        "dur_us": p["dur_us"],
        "nchan": p["nchan"],
        "names": p["names"],
        "traces": traces,
    }


INDEX = """<!doctype html><html><head><meta charset=utf-8>
<title>la_probe waveforms</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
 body{font:13px/1.4 -apple-system,system-ui,sans-serif;margin:0;background:#0f1117;color:#d7dae0}
 header{padding:8px 14px;background:#171a22;border-bottom:1px solid #2a2f3a;display:flex;
   gap:14px;align-items:center;flex-wrap:wrap}
 select,button{background:#222735;color:#d7dae0;border:1px solid #3a4152;border-radius:6px;
   padding:5px 9px;font:inherit}
 button{cursor:pointer} button.on{background:#2b6cb0;border-color:#2b6cb0}
 label{display:inline-flex;gap:4px;align-items:center;user-select:none}
 #meta{color:#8b93a7;margin-left:auto} #chans label{margin-right:8px}
 #plot{height:calc(100vh - 100px)}
 .chip{font-size:11px;color:#8b93a7}
</style></head><body>
<header>
 <b>la_probe</b>
 <label>file <select id=file></select></label>
 <label><input type=checkbox id=latest checked> follow latest</label>
 <label><input type=checkbox id=auto checked> auto-refresh</label>
 <span id=chans></span>
 <button id=reload>reload</button>
 <span id=meta></span>
</header>
<div id=plot></div>
<script>
let cur=null, files=[], sel=new Set([0,1,2,3,4,5,6,7]);
const q=s=>document.querySelector(s);
async function j(u){return (await fetch(u)).json();}
function fmtT(t){return t.toFixed(t<10?2:t<1000?1:0)+'us';}
async function loadFiles(){
  files=await j('/api/files');
  const f=q('#file'); const keep=f.value;
  f.innerHTML=files.map(x=>`<option>${x.name}</option>`).join('');
  if(q('#latest').checked && files.length) f.value=files[0].name;
  else if(keep) f.value=keep;
}
function chanBoxes(nchan,names){
  q('#chans').innerHTML=[...Array(nchan).keys()].map(c=>
    `<label><input type=checkbox class=ch data-c=${c} ${sel.has(c)?'checked':''}>${names[c]||('D'+c)}</label>`
  ).join('');
  document.querySelectorAll('.ch').forEach(cb=>cb.onchange=()=>{
    const c=+cb.dataset.c; cb.checked?sel.add(c):sel.delete(c); draw();
  });
}
async function draw(){
  const name=q('#file').value; if(!name) return;
  const chans=[...sel].sort((a,b)=>a-b).join(',');
  const d=await j('/api/wave?file='+encodeURIComponent(name)+'&chans='+chans);
  cur=d;
  const gap=2.2; const traces=[]; const yt=[],yl=[];
  d.traces.forEach((t,i)=>{
    const off=i*gap;
    traces.push({x:t.x,y:t.y.map(v=>v+off),mode:'lines',line:{shape:'hv',width:1.5},
      name:t.name+(t.truncated?' (trunc)':''),hovertemplate:'%{x:.2f}us<extra>'+t.name+'</extra>'});
    yt.push(off+0.5); yl.push(t.name);
  });
  const dark={paper_bgcolor:'#0f1117',plot_bgcolor:'#0f1117',font:{color:'#d7dae0'},
    margin:{l:70,r:20,t:10,b:40},showlegend:false,
    xaxis:{title:'time (us)',gridcolor:'#232838',zeroline:false},
    yaxis:{tickvals:yt,ticktext:yl,gridcolor:'#232838',zeroline:false,
      range:[-0.5,Math.max(2,d.traces.length*gap)]}};
  Plotly.react('plot',traces,dark,{responsive:true,displaylogo:false});
  const nm=Object.entries(d.names).map(([c,n])=>`${n}`).join(' ');
  q('#meta').innerHTML=`<span class=chip>${(d.hz/1e6).toFixed(0)}MHz · `+
    `${d.dur_us.toFixed(0)}us · ${d.traces.reduce((a,t)=>a+t.edges,0)} edges</span>`;
  if(!q('#chans').children.length) chanBoxes(d.nchan,d.names);
}
async function tick(){
  if(!q('#auto').checked) return;
  const prev=q('#file').value;
  await loadFiles();
  if(q('#file').value!==prev || !cur) draw();
}
q('#reload').onclick=async()=>{await loadFiles();draw();};
q('#file').onchange=draw; q('#latest').onchange=()=>{loadFiles().then(draw);};
(async()=>{await loadFiles(); await draw(); setInterval(tick,3000);})();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    directory = DIR

    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path in ("/", "/index.html"):
                self._send(200, INDEX, "text/html; charset=utf-8")
            elif u.path == "/api/files":
                self._send(200, json.dumps(_sr_files(self.directory)))
            elif u.path == "/api/wave":
                qs = parse_qs(u.query)
                name = qs.get("file", [""])[0]
                chans = [int(c) for c in qs.get("chans", ["0"])[0].split(",") if c != ""]
                self._send(200, json.dumps(_wave_json(self.directory, name, chans, 60000)))
            else:
                self._send(404, json.dumps({"error": "not found"}))
        except Exception as e:  # keep the server alive; surface the error
            self._send(500, json.dumps({"error": str(e)}))

    def log_message(self, *a):  # quiet
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=DIR)
    ap.add_argument("--port", type=int, default=8091)
    args = ap.parse_args()
    Handler.directory = args.dir
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"waveform_server on :{args.port} serving {args.dir}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
