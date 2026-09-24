"""Octilinear visibility trees with terminal anchoring and exact clearance callback.

Reconstruct copper, including new shared junctions; this is not cycle deletion.
Pure geometry in mm, no board/net/ref-specific routing rules.
"""
import math,heapq,itertools
from collections import defaultdict

def point(p):return tuple(round(v,6) for v in p)
def elbows(a,b):
 a,b=point(a),point(b);dx=b[0]-a[0];dy=b[1]-a[1];d=min(abs(dx),abs(dy));sx=1 if dx>=0 else -1;sy=1 if dy>=0 else -1
 paths=[[a,(a[0]+sx*d,a[1]+sy*d),b],[a,(b[0]-sx*d,b[1]-sy*d),b],[a,(a[0],b[1]),b],[a,(b[0],a[1]),b]]
 return list(dict.fromkeys(tuple(dict.fromkeys(map(point,p))) for p in paths))
def length(edges):return sum(math.dist(a,b) for a,b in edges)
def tree(terminals,seeds,clear,*,max_nodes=180):
 """Best greedy terminal tree across several roots on one clearance graph.

Candidate junctions include elbows between terminals and projection onto old
segments. Every edge must pass the supplied exact-width clearance check.
"""
 terminals=sorted(set(map(point,terminals)))
 if len(terminals)<2:return None
 nodes=set(terminals)
 neighbors=defaultdict(set)
 for a,b in seeds:
  a,b=point(a),point(b);neighbors[a].add(b);neighbors[b].add(a)
 for p,near in neighbors.items():
  if p in nodes or len(near)!=2:nodes.add(p);continue
  a,b=near
  if abs(math.dist(a,p)+math.dist(p,b)-math.dist(a,b))>1e-6:nodes.add(p)
 for terminal in terminals:
  nearby=sorted(neighbors,key=lambda p:math.dist(p,terminal))[:4]
  for near in nearby:
   if math.dist(near,terminal)<2:
    for path in elbows(terminal,near):nodes.update(path)
 for a,b in itertools.combinations(terminals,2):
  for path in elbows(a,b):nodes.update(path)
 if len(nodes)>max_nodes:return None
 nodes=sorted(nodes);indices={p:i for i,p in enumerate(nodes)};adj=[[] for _ in nodes]
 for i,a in enumerate(nodes):
  for j in range(i):
   b=nodes[j];dx=abs(a[0]-b[0]);dy=abs(a[1]-b[1])
   if min(dx,dy)>1e-5 and abs(dx-dy)>1e-5:continue
   if clear(a,b):
    dist=math.dist(a,b);adj[i].append((j,dist));adj[j].append((i,dist))
 wanted={indices[p] for p in terminals};best=None
 for root in sorted(wanted):
  connected={root};remaining=wanted-{root};edges=set()
  while remaining:
   distance={n:0 for n in connected};parent={};queue=[(0,n) for n in connected];heapq.heapify(queue);hit=None
   while queue:
    cost,n=heapq.heappop(queue)
    if cost!=distance[n]:continue
    if n in remaining:hit=n;break
    for j,d in adj[n]:
     new=cost+d
     if new<distance.get(j,math.inf)-1e-9:distance[j]=new;parent[j]=n;heapq.heappush(queue,(new,j))
   if hit is None:break
   while hit not in connected:
    old=parent[hit];edges.add(tuple(sorted((hit,old))));connected.add(hit);hit=old
   remaining-=connected
  if remaining:continue
  result=[(nodes[a],nodes[b]) for a,b in sorted(edges)];score=length(result)
  if best is None or score<best[0]:best=(score,result)
 return None if best is None else best[1]
