import bpy,json,hashlib,argparse,sys,math
from pathlib import Path
from mathutils import Vector
parser=argparse.ArgumentParser();parser.add_argument('--output',default='output/advertising-kit-20261008')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
out=Path(args.output);reports=[]
for path in sorted((out/'blender').glob('*.blend')):
 bpy.ops.wm.open_mainfile(filepath=str(path.resolve()));s=bpy.context.scene
 lights=[o for o in s.objects if o.type=='LIGHT' and not o.hide_render]
 assert len(lights)==1 and lights[0].data.type=='AREA',(path,lights)
 backgrounds=[n for n in s.world.node_tree.nodes if n.type=='BACKGROUND']
 assert len(backgrounds)==1 and backgrounds[0].inputs['Strength'].default_value==0
 assert tuple(backgrounds[0].inputs['Color'].default_value)==(0,0,0,1)
 assert not any(n.type in ['TEX_ENVIRONMENT','VOLUME_SCATTER','VOLUME_PRINCIPLED'] for n in s.world.node_tree.nodes)
 assert not any(o.name=='Charcoal velvet' for o in s.objects)
 checked=set()
 for ob in s.objects:
  if ob.type!='MESH':continue
  for slot in ob.material_slots:
   mat=slot.material
   if not mat or not mat.use_nodes or mat.name in checked:continue
   checked.add(mat.name)
   for n in mat.node_tree.nodes:
    socket=n.inputs.get('Emission Strength') if n.type=='BSDF_PRINCIPLED' else n.inputs.get('Strength') if n.type=='EMISSION' else None
    if socket:assert not socket.is_linked and socket.default_value==0,(path,mat.name,n.name)
 assert s.render.fps==24 and s.render.fps_base==1
 assert s.render.resolution_x==1920 and s.render.resolution_y==1080 and s.render.resolution_percentage==100
 angles=[]
 if path.stem!='family-studio':
  for f in [s.frame_start,s.frame_end]:
   s.frame_set(f)
   target=Vector((0,.01,.014)) if path.stem=='family-pullback' else s.objects['Product / mini'].location if path.stem=='mini-macro-roll' else Vector()
   dot=(lights[0].location-target).normalized().dot((s.camera.location-target).normalized());angles.append(dot)
  assert angles[0]<0 and angles[1]>0,(path,angles)
 motion=None
 if path.stem=='mini-macro-roll':
  rotations=[];positions=[]
  for frame in range(s.frame_start,s.frame_end+1):
   s.frame_set(frame);pivot=s.objects['Product / mini'];rotations.append(pivot.rotation_euler.to_quaternion());positions.append(pivot.location.copy())
  steps=[]
  for before,after in zip(rotations,rotations[1:]):
   delta=before.rotation_difference(after)
   steps.append(math.degrees(2*math.atan2(math.sqrt(delta.x*delta.x+delta.y*delta.y+delta.z*delta.z),abs(delta.w))))
  distances=[(b-a).length*1000 for a,b in zip(positions,positions[1:])]
  motion=dict(travel_mm=sum(distances),peak_mm_per_second=max(distances)*s.render.fps,duration_seconds=len(rotations)/s.render.fps,attitude_travel_degrees=sum(steps),peak_degrees_per_second=max(steps)*s.render.fps)
 reports.append(dict(motion=motion,file=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),lights=1,world_strength=0,emitting_materials=0,checked_materials=len(checked),floor=False,resolution=[1920,1080],fps=24,engine=s.render.engine,samples=s.cycles.samples if s.render.engine=='CYCLES' else s.eevee.taa_render_samples,denoiser_quality=s.cycles.denoising_quality if s.render.engine=='CYCLES' else None,camera_side_dot_start_end=angles))
assert len(reports)==6
(out/'review/scene-audit.json').write_text(json.dumps(reports,indent=2));print('SINGLE SOURCE SCENE AUDIT PASSED',len(reports))
