"""Seeded zero-gravity rigid-body SKU field using current real CAD.
Blender -b --python hardware/mechanical/render_asteroids.py
"""
import sys,random
ASTRO_HD="--hd" in sys.argv
ASTRO_FRAMES=720 if ASTRO_HD else 192
from pathlib import Path
# Reuse the canonical geometry/material setup without executing its shot loop.
sys.argv=[sys.argv[0]]
exec((Path.cwd()/'hardware/mechanical/render_motion_candidates.py').read_text().split('\nspecs=[')[0])
OUT=ROOT/('output/asteroids-hd-r1' if ASTRO_HD else 'output/asteroids-r1');OUT.mkdir(exist_ok=True)
rng=random.Random(20260922)
floor.hide_render=True;haze.hide_render=True
scene.gravity=(0,0,0);scene.frame_start=1;scene.frame_end=ASTRO_FRAMES
scene.cycles.samples=16 if ASTRO_HD else 4
if ASTRO_HD:
 scene.render.resolution_x=1920;scene.render.resolution_y=1080
 # Prefer the dedicated Mac's Metal GPU; report the selected device.
 prefs=bpy.context.preferences.addons['cycles'].preferences
 try:
  prefs.compute_device_type='METAL';prefs.get_devices()
  for d in prefs.devices:d.use=d.type=='METAL'
  if any(d.type=='METAL' for d in prefs.devices):scene.cycles.device='GPU'
 except Exception as e:print('GPU fallback',e,flush=True)
 print('RENDER DEVICE',scene.cycles.device,[(d.name,d.use) for d in prefs.devices],flush=True)
 # Evaluate bevel/normal modifiers once, then share render-ready meshes.
 deps=bpy.context.evaluated_depsgraph_get()
 for objs in groups.values():
  for ob in objs:
   mesh=bpy.data.meshes.new_from_object(ob.evaluated_get(deps),depsgraph=deps)
   ob.modifiers.clear();ob.data=mesh
cam.location=(0,0,1.5);camdata.lens=50;aim(cam,(0,0,0))
bg.inputs['Strength'].default_value=.16
for ob,loc,power in [(sweep,(-.35,.2,.7),24),(fill,(.4,-.3,.8),18),(rim,(-.2,-.2,-.5),12)]:
 ob.location=loc;ob.data.energy=power;ob.data.size=.45;ob.data.size_y=.7;aim(ob,(0,0,0))
# Meshes are shared between instances; each full assembly follows one hidden
# conservative box collider. Bullet supplies contact impulses and induced spin.
records=[];bodies=[]
products=['splanc','mini','max']+[rng.choice(['mini','mini','splanc','max']) for _ in range(40 if ASTRO_HD else 7)]
for idx,product in enumerate(products):
 side=-1 if idx%2==0 else 1
 release=4 if idx<2 else 4+(idx-1)*(17 if ASTRO_HD else 13)
 y=0 if idx<2 else rng.uniform(-.19,.19)
 velocity=Vector((-side*rng.uniform(.19,.28),rng.uniform(-.025,.025),0))
 origin=Vector((side*(.62+sizes[product].x/2),y,0))
 bpy.ops.mesh.primitive_cube_add(size=1,location=origin)
 body=bpy.context.object;body.name=f'Asteroid {idx:02} / {product}'
 body.dimensions=sizes[product]+Vector((.001,.001,.001))
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 bpy.ops.rigidbody.object_add();rb=body.rigid_body;rb.collision_shape='BOX';rb.mass={'mini':.12,'splanc':.22,'max':1.3}[product];rb.friction=.15;rb.restitution=.92;rb.linear_damping=0;rb.angular_damping=0;rb.use_deactivation=False;rb.use_margin=True;rb.collision_margin=.0005
 body.hide_render=True;body.display_type='WIRE'
 for source in groups[product]:
  ob=source.copy();ob.data=source.data;scene.collection.objects.link(ob);ob.parent=body;ob.hide_render=False
 axis=Vector((rng.uniform(-.4,.4),rng.uniform(-.4,.4),rng.uniform(.6,1))).normalized()
 spin=rng.uniform(.7,1.5)*(-1 if idx%2 else 1)
 initial=Quaternion((0,0,1),rng.uniform(-.8,.8))@Quaternion((1,0,0),rng.uniform(-.25,.25))
 body.rotation_mode='QUATERNION'
 for frame in [1,max(1,release-2),release-1]:
  dt=(frame-release+1)/24
  body.location=origin+velocity*dt
  body.rotation_quaternion=Quaternion(axis,spin*dt)@initial
  body.keyframe_insert('location',frame=frame);body.keyframe_insert('rotation_quaternion',frame=frame)
 rb.kinematic=True;body.keyframe_insert('rigid_body.kinematic',frame=1);body.keyframe_insert('rigid_body.kinematic',frame=release-1)
 rb.kinematic=False;body.keyframe_insert('rigid_body.kinematic',frame=release)
 for fc in body.animation_data.action.fcurves:
  for k in fc.keyframe_points:k.interpolation='CONSTANT' if 'kinematic' in fc.data_path else 'LINEAR'
 bodies.append(body);records.append(dict(id=idx,sku=product,release=release,launch=list(origin),velocity=list(velocity),spin=spin))
for objs in groups.values():
 for ob in objs:ob.hide_render=True
world=scene.rigidbody_world;world.substeps_per_frame=8;world.solver_iterations=30;world.point_cache.frame_start=1;world.point_cache.frame_end=ASTRO_FRAMES
# Bake Bullet once so stills and video use identical collision trajectories.
scene.frame_set(1)
with bpy.context.temp_override(scene=scene,point_cache=world.point_cache):bpy.ops.ptcache.bake(bake=True)
trajectory=[]
for f in range(1,ASTRO_FRAMES+1):
 scene.frame_set(f);deps=bpy.context.evaluated_depsgraph_get()
 trajectory.append(dict(frame=f,bodies=[dict(id=i,position=list(b.evaluated_get(deps).matrix_world.translation),rotation=list(b.evaluated_get(deps).matrix_world.to_quaternion())) for i,b in enumerate(bodies)]))
(OUT/'simulation.json').write_text(json.dumps(dict(seed=20260922,gravity=[0,0,0],collision='conservative full-assembly boxes / Bullet',instances=records,trajectory=trajectory)))
(OUT/'catalog.json').write_text(json.dumps([dict(name='asteroids',frames=ASTRO_FRAMES,resolution=[scene.render.resolution_x,scene.render.resolution_y])]))
dest=OUT/'asteroids';dest.mkdir(exist_ok=True)
scene.render.image_settings.file_format='PNG'
for f in ((96,360,600) if ASTRO_HD else (60,96,132)):
 scene.frame_set(f);scene.render.filepath=str(dest/f'frame-{f:03}.png');bpy.ops.render.render(write_still=True)
if ASTRO_HD:
 frames_dir=dest/'frames';frames_dir.mkdir(exist_ok=True)
 for f in range(1,ASTRO_FRAMES+1):
  path=frames_dir/f'{f:04}.png'
  if path.exists():continue
  scene.frame_set(f);scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
  print('HD FRAME',f,'/',ASTRO_FRAMES,flush=True)
 # Encode the checkpointed image sequence without rerendering 3D.
 scene.sequence_editor_clear();ed=scene.sequence_editor_create();strips=ed.strips if hasattr(ed,'strips') else ed.sequences
 strip=strips.new_image('HD frames',str(frames_dir/'0001.png'),channel=1,frame_start=1)
 for f in range(2,ASTRO_FRAMES+1):strip.elements.append(f'{f:04}.png')
 scene.render.use_sequencer=True;scene.view_settings.view_transform='Standard';scene.view_settings.look='None';scene.view_settings.exposure=0
scene.render.image_settings.file_format='FFMPEG';scene.render.ffmpeg.format='MPEG4';scene.render.ffmpeg.codec='H264';scene.render.ffmpeg.constant_rate_factor='MEDIUM';scene.render.filepath=str(dest/'asteroids.mp4');bpy.ops.render.render(animation=True)
print('COMPLETE ASTEROIDS',flush=True)
