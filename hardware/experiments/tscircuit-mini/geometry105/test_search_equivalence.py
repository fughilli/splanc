import random,time,json
from pnr.route.detail.keyhole import route
from pnr.route.detail.keyhole_reference import route as reference
from pnr.route.detail.regional import segment_distance
cases=[]
for seed in range(25):
 rng=random.Random(seed);walls=[((2,0),(2,rng.uniform(5.5,7))),((5,rng.uniform(1,2.5)),(5,8))]
 def clear(a,b):return all(segment_distance(a,b,c,d)>.18 for c,d in walls)
 kwargs=dict(sources=[(.25,4)],targets=[(7.75,4)],bounds=(0,0,8,8),clear=clear,pitch=.25,max_expansions=3000)
 outputs=[];times=[]
 for fn in (reference,route):
  started=time.perf_counter();out=fn(**kwargs);times.append(time.perf_counter()-started);outputs.append(out)
 assert vars(outputs[0])==vars(outputs[1]),(seed,outputs)
 cases.append(dict(seed=seed,reference_seconds=times[0],indexed_seconds=times[1],status=outputs[1].status,expanded=outputs[1].expanded))
assert sum(x['expanded'] for x in cases)>1000
print('PASS exact path/status/expansion/raw-length equivalence on',len(cases),'seeded obstacle cases');print('total seconds',sum(x['reference_seconds'] for x in cases),sum(x['indexed_seconds'] for x in cases));open('output/geometry105/search-equivalence.json','w').write(json.dumps(cases,indent=2))
