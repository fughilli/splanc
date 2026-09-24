"""Optional Rust A* backend. Never bypass Python's exact clearance oracle."""
import ctypes,os
from functools import lru_cache
class Grid(ctypes.Structure):
 _fields_=[('nx',ctypes.c_size_t),('ny',ctypes.c_size_t),('x0',ctypes.c_double),('y0',ctypes.c_double),('pitch',ctypes.c_double),('bend',ctypes.c_double),('budget',ctypes.c_size_t)]
Callback=ctypes.CFUNCTYPE(ctypes.c_int,ctypes.c_size_t,ctypes.c_size_t)
@lru_cache(maxsize=1)
def library():
 lib=ctypes.CDLL(os.environ['PNR_RUST_SEARCH_LIB']);lib.pnr_search.restype=ctypes.c_ssize_t;lib.pnr_search.argtypes=[ctypes.POINTER(Grid),ctypes.POINTER(ctypes.c_size_t),ctypes.POINTER(ctypes.c_double),ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t),ctypes.c_size_t,ctypes.POINTER(ctypes.c_double),ctypes.c_size_t,Callback,ctypes.POINTER(ctypes.c_size_t),ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t)];return lib

def search(starts,ends,targets,bounds,pitch,bend,budget,clear):
 from .keyhole import length
 x0,y0,x1,y1=bounds;nx=int((x1-x0)/pitch)+1;ny=int((y1-y0)/pitch)+1;cells=nx*ny
 if cells>4_000_000:raise ValueError('Rust grid memory limit exceeded')
 @lru_cache(maxsize=None)
 def point(cell):return round(x0+(cell//ny)*pitch,9),round(y0+(cell%ny)*pitch,9)
 errors=[]
 @Callback
 def callback(a,b):
  try:return int(bool(clear(point(a),point(b))))
  except BaseException as ex:errors.append(ex);return -1
 starts_array=(ctypes.c_size_t*len(starts))(*(i*ny+j for i,j in starts));cost_array=(ctypes.c_double*len(starts))(*(length(p) for p in starts.values()));ends_array=(ctypes.c_size_t*len(ends))(*(i*ny+j for i,j in ends));target_array=(ctypes.c_double*(2*len(targets)))(*(v for t in targets for v in t));out=(ctypes.c_size_t*min(cells*9,budget+1))();expanded=ctypes.c_size_t();grid=Grid(nx,ny,x0,y0,pitch,bend,budget)
 result=library().pnr_search(ctypes.byref(grid),starts_array,cost_array,len(starts),ends_array,len(ends),target_array,len(targets),callback,out,len(out),ctypes.byref(expanded))
 if errors:raise errors[0]
 if result==-3:raise ValueError('Invalid Rust search input or output bound')
 if result==-2:raise RuntimeError('Rust search aborted without a recorded oracle error')
 if result<=0:return None,'search_budget' if result==-1 else 'no_channel_at_pitch',expanded.value
 nodes=[(out[i]//ny,out[i]%ny) for i in range(result)];return nodes,'routed',expanded.value
