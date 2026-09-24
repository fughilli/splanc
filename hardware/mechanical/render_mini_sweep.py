"""Draft Mini highlight sweep, using current CAD and packed campaign materials.
Run with Blender -b --python hardware/mechanical/render_mini_sweep.py.
"""
import bpy,json,math
from pathlib import Path
from mathutils import Vector
ROOT=Path.cwd(); OUT=ROOT/'output/mini-highlight-preview-r1';OUT.mkdir(exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'output/product-renders-campaign-r3/splanc-products.blend'))
scene=bpy.context.scene
# Recover material assignments before replacing historical CAD.
old=json.loads((ROOT/'output/product-renders-campaign-r3/scene.json').read_text())
mats={}
for item in old['items']:
 ob=bpy.data.objects.get(item['product']+'/'+item['name'])
 if ob and ob.data.materials:mats[item['material']]=ob.data.materials[0]
for ob in list(bpy.data.objects):
 if ob.type=='MESH' and ob.name!='Studio ground':bpy.data.objects.remove(ob,do_unlink=True)
from sys import path
path.insert(0,str(ROOT/'hardware/mechanical'))
from ambient_materials import physical_uvs
items=json.loads((ROOT/'output/button-flexure-r1/scene.json').read_text())['items']
objs=[]
for item in items:
 if item['product']!='mini':continue
 me=bpy.data.meshes.new(item['name']);me.from_pydata([[v*.001 for v in xyz] for xyz in item['vertices']],[],item['faces']);me.update()
 ob=bpy.data.objects.new('mini/'+item['name'],me);scene.collection.objects.link(ob);objs.append(ob)
 me.materials.append(mats.get(item['material'],mats['nylon']));physical_uvs(me,item['material'])
 bevel=ob.modifiers.new('Optical edges','BEVEL');bevel.width=.00008;bevel.segments=2;bevel.limit_method='ANGLE';bevel.angle_limit=.65
 ob.modifiers.new('Surface normals','WEIGHTED_NORMAL')
points=[Vector(v)*.001 for i in items if i['product']=='mini' for v in i['vertices']]
lo=Vector([min(p[k] for p in points) for k in range(3)]);hi=Vector([max(p[k] for p in points) for k in range(3)]);center=(lo+hi)*.5
span=max(hi.x-lo.x,hi.y-lo.y)
def aim(ob,target):ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
cam=scene.camera;cam.data.type='PERSP';cam.data.lens=62;cam.data.clip_start=.001;cam.data.dof.use_dof=False
scene.frame_start=1;scene.frame_end=96;scene.render.fps=24
for ob in bpy.data.objects:
 if ob.type=='LIGHT':ob.hide_render=True
# Keep the specified environment as a restrained base; moving strip supplies the sweep.
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.045
light=bpy.data.lights.new('Moving strip softbox','AREA');light.shape='RECTANGLE';light.size=.022;light.size_y=.23;light.energy=4.5
sweep=bpy.data.objects.new('Moving strip softbox',light);scene.collection.objects.link(sweep)
fill=bpy.data.lights.new('Quiet front fill','AREA');fill.energy=.6;fill.shape='DISK';fill.size=.2
fo=bpy.data.objects.new('Quiet front fill',fill);scene.collection.objects.link(fo);fo.location=center+Vector((-.08,-.15,.16));aim(fo,center)
# Small camera arc + push-in, single light pass left-to-right; restrained bookends.
for f in range(1,97):
 t=(f-1)/95;s=t*t*(3-2*t)
 angle=math.radians(-65+12*s);distance=span*(2.8-.12*s)
 cam.location=center+Vector((math.cos(angle)*distance,math.sin(angle)*distance,span*(1.95-.12*s)));aim(cam,center)
 cam.keyframe_insert('location',frame=f);cam.keyframe_insert('rotation_euler',frame=f)
 sweep.location=center+Vector((-.20+.40*s,.075,.15));aim(sweep,center)
 sweep.keyframe_insert('location',frame=f);sweep.keyframe_insert('rotation_euler',frame=f)
scene.render.engine='CYCLES';scene.cycles.samples=8;scene.cycles.use_denoising=True
scene.cycles.max_bounces=4;scene.render.threads_mode='FIXED';scene.render.threads=8
scene.render.resolution_x=640;scene.render.resolution_y=360;scene.render.resolution_percentage=100
scene.view_settings.exposure=-.5
scene.render.image_settings.file_format='FFMPEG';scene.render.ffmpeg.format='MPEG4';scene.render.ffmpeg.codec='H264';scene.render.ffmpeg.constant_rate_factor='MEDIUM'
scene.render.filepath=str(OUT/'mini-highlight-preview.mp4')
scene.frame_set(1);bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'mini-highlight-preview.blend'))
(OUT/'shot.json').write_text(json.dumps(dict(cad='button-flexure-r1',duration_seconds=4,fps=24,frames=96,resolution=[640,360],samples=8,camera='12 degree arc and gentle push-in',light='single rectangular softbox sweep',status='motion/lighting draft'),indent=2))
bpy.ops.render.render(animation=True)
# Actual rendered bookends and midpoint for visual QA.
scene.render.image_settings.file_format='PNG'
for f in (1,48,96):
 scene.frame_set(f);scene.render.filepath=str(OUT/f'frame-{f:03}.png');bpy.ops.render.render(write_still=True)
