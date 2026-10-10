//! Heading-aware A* kernel. Geometry stays in the caller's exact oracle.
use std::{cmp::Ordering,collections::BinaryHeap,slice};
#[repr(C)]
pub struct Grid { nx:usize, ny:usize, x0:f64, y0:f64, pitch:f64, bend:f64, budget:usize }
#[derive(Clone,Copy)]
struct Entry { f:f64, g:f64, state:usize }
impl PartialEq for Entry {fn eq(&self,b:&Self)->bool{self.f==b.f&&self.g==b.g&&self.state==b.state}}
impl Eq for Entry {}
impl Ord for Entry {fn cmp(&self,b:&Self)->Ordering {b.f.total_cmp(&self.f).then_with(||b.g.total_cmp(&self.g)).then_with(||b.state.cmp(&self.state))}}
impl PartialOrd for Entry {fn partial_cmp(&self,b:&Self)->Option<Ordering>{Some(self.cmp(b))}}
type Clear = extern "C" fn(usize,usize)->i32;
#[no_mangle]
pub unsafe extern "C" fn pnr_search(grid:*const Grid,starts:*const usize,start_cost:*const f64,ns:usize,ends:*const usize,ne:usize,targets:*const f64,nt:usize,clear:Clear,out:*mut usize,capacity:usize,expanded:*mut usize)->isize {
 if grid.is_null()||starts.is_null()||start_cost.is_null()||ends.is_null()||targets.is_null()||out.is_null()||expanded.is_null(){return -3;}
 let g=&*grid;
 let Some(cells)=g.nx.checked_mul(g.ny) else{return -3;};
 if cells==0||cells>4_000_000||ns==0||ne==0||nt==0||g.pitch<=0.||!g.pitch.is_finite(){return -3;}
 let starts=slice::from_raw_parts(starts,ns);let initial=slice::from_raw_parts(start_cost,ns);let ends=slice::from_raw_parts(ends,ne);let targets=slice::from_raw_parts(targets,nt*2);
 if starts.iter().chain(ends).any(|c|*c>=cells){return -3;}
 let mut cost=vec![f64::INFINITY;cells*9];let mut parent=vec![usize::MAX;cells*9];let mut edge=vec![-1i8;cells*8];let mut goal=vec![false;cells];let mut heuristic=vec![f64::NAN;cells];let mut heap=BinaryHeap::new();
 for c in ends{goal[*c]=true;}
 // Coordinates use the same 1nm rounding as the Python reference grid.
 let h=|c:usize,cache:&mut Vec<f64>|->f64 {
  if cache[c].is_nan(){let x=((g.x0+(c/g.ny) as f64*g.pitch)*1e9).round()/1e9;let y=((g.y0+(c%g.ny) as f64*g.pitch)*1e9).round()/1e9;cache[c]=targets.chunks_exact(2).map(|p|(x-p[0]).hypot(y-p[1])).fold(f64::INFINITY,f64::min);}
  cache[c]
 };
 for (&c,&v) in starts.iter().zip(initial){let state=c*9+8;cost[state]=v;heap.push(Entry{f:v+h(c,&mut heuristic),g:v,state});}
 let dirs:[(isize,isize);8]=[(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1),(0,-1),(1,-1)];let mut count=0;
 while !heap.is_empty()&&count<g.budget {
  let entry=heap.pop().unwrap();if entry.g!=cost[entry.state]{continue;}let c=entry.state/9;let heading=entry.state%9;count+=1;
  if goal[c]{let mut path=vec![c];let mut s=entry.state;while parent[s]!=usize::MAX{s=parent[s];path.push(s/9);}if path.len()>capacity{return -3;}for (i,v) in path.iter().rev().enumerate(){*out.add(i)=*v;}*expanded=count;return path.len() as isize;}
  let i=c/g.ny;let j=c%g.ny;
  for (nh,(di,dj)) in dirs.iter().enumerate(){let ni=i as isize+di;let nj=j as isize+dj;if ni<0||nj<0||ni>=g.nx as isize||nj>=g.ny as isize{continue;}
   let next=ni as usize*g.ny+nj as usize;let key=if c<next{c*8+nh}else{next*8+(nh+4)%8};
   if edge[key]<0{let value=clear(c,next);if value<0{*expanded=count;return -2;}edge[key]=if value>0{1}else{0};}if edge[key]==0{continue;}
   let distance=if di.abs()+dj.abs()==2{std::f64::consts::SQRT_2}else{1.};let ng=entry.g+g.pitch*distance+if heading!=8&&heading!=nh{g.bend}else{0.};let state=next*9+nh;
   if ng>=cost[state]{continue;}cost[state]=ng;parent[state]=entry.state;heap.push(Entry{f:ng+h(next,&mut heuristic),g:ng,state});
  }
 }
 *expanded=count;if heap.is_empty(){0}else{-1}
}
