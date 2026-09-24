import math, random, unittest
from pnr.route.detail.joint import conflict
from pnr.route.detail.regional import Request, segment_distance

class ConflictBoundsTest(unittest.TestCase):
    def test_matches_exact_distance_for_random_and_touching_primitives(self):
        rng=random.Random(73)
        for i in range(20000):
            same=i%7==0
            ar=Request('a','a',[],[],rng.uniform(.1,2),rng.uniform(.1,.4))
            br=Request('b','a' if same else 'b',[],[],rng.uniform(.1,2),rng.uniform(.1,.4))
            ak,bk=[rng.choice(['track','via']) for _ in range(2)]
            al,bl=[rng.randrange(4) for _ in range(2)]
            ap,aq,bp,bq=[tuple(rng.uniform(-10,10) for _ in range(2)) for _ in range(4)]
            if ak=='via':aq=ap
            if bk=='via':bq=bp
            a=(ak,al,ap,aq);b=(bk,bl,bp,bq)
            if same:expected=ak==bk=='via' and 1e-8<math.dist(ap,bp)<.501-1e-9
            elif ak==bk=='track' and al!=bl:expected=False
            else:expected=segment_distance(ap,aq,bp,bq)<((ar.width if ak=='track' else .6)+(br.width if bk=='track' else .6))/2+max(ar.clearance,br.clearance)-1e-9
            self.assertEqual(conflict(ar,a,br,b),expected,(a,b))
        ar=Request('a','a',[],[],.2,.15);br=Request('b','b',[],[],.2,.15)
        for offset in [-2e-9,0,2e-9]:
            a=('track',0,(0,0),(2,0));b=('track',0,(0,.35+offset),(2,.35+offset))
            self.assertEqual(conflict(ar,a,br,b),offset< -1e-9)

if __name__=='__main__':unittest.main()
