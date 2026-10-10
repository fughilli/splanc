"""Low-quality motion studies from real r5 CAD; no generated product geometry.
Blender -b --python hardware/mechanical/render_motion_candidates.py -- [--stills] [--shot NAME]
"""
import bpy,json,math,sys,argparse
from pathlib import Path
from mathutils import Vector,Quaternion
ROOT=Path.cwd();OUT=ROOT/'output/motion-studies-r1';OUT.mkdir(exist_ok=True)
ap=argparse.ArgumentParser();ap.add_argument('--macro-pass',action='store_true');ap.add_argument('--stills',action='store_true');ap.add_argument('--shot');ap.add_argument('--samples',type=int,default=6);args=ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if args.macro_pass:
 OUT=ROOT/'output/motion-studies-r3';OUT.mkdir(exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'output/product-renders-campaign-r3/splanc-products.blend'))
scene=bpy.context.scene
old=json.loads((ROOT/'output/product-renders-campaign-r3/scene.json').read_text());mats={}
for i in old['items']:
 ob=bpy.data.objects.get(i['product']+'/'+i['name'])
 if ob and ob.type=='MESH' and ob.data.materials:mats[i['material']]=ob.data.materials[0]
for ob in list(bpy.data.objects):bpy.data.objects.remove(ob,do_unlink=True)
sys.path.insert(0,str(ROOT/'hardware/mechanical'));from ambient_materials import physical_uvs
items=json.loads((ROOT/'output/compact-handheld-r9/scene.json').read_text())['items'];groups={};pivots={};sizes={}
for product in ('mini','splanc','max'):
 selected=[i for i in items if i['product']==product];vs=[v for i in selected for v in i['vertices']]
 lo=Vector([min(v[k] for v in vs)*.001 for k in range(3)]);hi=Vector([max(v[k] for v in vs)*.001 for k in range(3)]);center=(lo+hi)/2;sizes[product]=hi-lo
 pivot=bpy.data.objects.new('Motion / '+product,None);scene.collection.objects.link(pivot);pivots[product]=pivot;groups[product]=[]
 for i in selected:
  me=bpy.data.meshes.new(product+'/'+i['name']);me.from_pydata([Vector(v)*.001 for v in i['vertices']],[],i['faces']);me.update();physical_uvs(me,i['material'])
  # Keep metric local coordinates for the existing object-space plastic mapping.
  ob=bpy.data.objects.new(product+'/'+i['name'],me);scene.collection.objects.link(ob);ob.parent=pivot;ob.location=-center
  me.materials.append(mats.get(i['material'],mats['nylon']));groups[product].append(ob)
  mod=ob.modifiers.new('Optical edge','BEVEL');mod.width=.00008;mod.segments=2;mod.limit_method='ANGLE';mod.angle_limit=.65;ob.modifiers.new('Surface normals','WEIGHTED_NORMAL')
# HDRI stays available to reflection and illumination rays; camera rays see black.
n=scene.world.node_tree.nodes;l=scene.world.node_tree.links;out=n.get('World Output') or next(v for v in n if v.type=='OUTPUT_WORLD');bg=next(v for v in n if v.type=='BACKGROUND');bg.inputs['Strength'].default_value=.06
black=n.new('ShaderNodeBackground');black.inputs['Color'].default_value=(0,0,0,1);black.inputs['Strength'].default_value=0
lp=n.new('ShaderNodeLightPath');mix=n.new('ShaderNodeMixShader');l.new(lp.outputs['Is Camera Ray'],mix.inputs[0]);l.new(bg.outputs[0],mix.inputs[1]);l.new(black.outputs[0],mix.inputs[2]);l.new(mix.outputs[0],out.inputs['Surface'])
def aim(ob,target):ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
def light(name,energy,size,loc):
 d=bpy.data.lights.new(name,'AREA');d.energy=energy;d.shape='RECTANGLE';d.size=size;d.size_y=size*4
 o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=loc;aim(o,(0,0,0));return o
sweep=light('Sweeping softbox',3,.025,(-.2,.1,.2));fill=light('Soft edge fill',.6,.15,(.2,-.15,.25));rim=light('Back rim',.7,.1,(-.15,.25,.1))
camdata=bpy.data.cameras.new('Motion camera');cam=bpy.data.objects.new('Motion camera',camdata);scene.collection.objects.link(cam);scene.camera=cam;camdata.lens=55;camdata.clip_start=.001;camdata.dof.use_dof=False
# Dark velvet with sheen and fine nap; deliberately no synthetic checker pattern.
velvet=bpy.data.materials.new('Charcoal velvet / draft');velvet.use_nodes=True;bs=velvet.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.008,.009,.013,1);bs.inputs['Roughness'].default_value=.92;bs.inputs['Sheen Weight'].default_value=.5;bs.inputs['Sheen Roughness'].default_value=.8;bs.inputs['Sheen Tint'].default_value=(.025,.028,.04,1)
tex=velvet.node_tree.nodes.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=1800;tex.inputs['Detail'].default_value=2
bump=velvet.node_tree.nodes.new('ShaderNodeBump');bump.inputs['Distance'].default_value=.00006;bump.inputs['Strength'].default_value=.2;velvet.node_tree.links.new(tex.outputs['Fac'],bump.inputs['Height']);velvet.node_tree.links.new(bump.outputs['Normal'],bs.inputs['Normal'])
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.0001));floor=bpy.context.object;floor.name='Velvet backdrop';floor.data.materials.append(velvet)
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,.06));haze=bpy.context.object;haze.name='Very light entrance haze';haze.scale=(.5,.5,.4)
volume=bpy.data.materials.new('Faint neutral haze');volume.use_nodes=True;vn=volume.node_tree.nodes;vn.clear();vo=vn.new('ShaderNodeOutputMaterial');scatter=vn.new('ShaderNodeVolumeScatter');scatter.inputs['Density'].default_value=.035;scatter.inputs['Anisotropy'].default_value=.2;volume.node_tree.links.new(scatter.outputs[0],vo.inputs['Volume']);haze.data.materials.append(volume)
scene.render.engine='CYCLES';scene.cycles.samples=args.samples;scene.cycles.use_denoising=True;scene.cycles.max_bounces=4;scene.render.use_persistent_data=True;scene.render.threads_mode='FIXED';scene.render.threads=8
scene.render.resolution_x=640;scene.render.resolution_y=360;scene.render.resolution_percentage=100;scene.render.fps=24;scene.view_settings.view_transform='AgX';scene.view_settings.exposure=-.5;scene.render.film_transparent=False
specs=[
 dict(name='entrance-a',kind='entrance',label='A · slow glide / late logo sweep',frames=96,arrival=.70,roll=68,endroll=22,light_start=.40,light_end=.90,haze=False),
 dict(name='entrance-b',kind='entrance',label='B · quick slide / stronger roll',frames=84,arrival=.53,roll=100,endroll=18,light_start=.23,light_end=.69,haze=False),
 dict(name='entrance-c',kind='entrance',label='C · floating glide / faint haze',frames=108,arrival=.77,roll=55,endroll=28,light_start=.34,light_end=.88,haze=True),
 dict(name='family-a',kind='family',label='A · centered pyramid / fast pullback',frames=96,zoom_start=.13,zoom_end=.53,layout='pyramid',distance=.76),
 dict(name='family-b',kind='family',label='B · wide lineup / staggered arrival',frames=96,zoom_start=.07,zoom_end=.30,layout='line',distance=1.08),
 dict(name='family-c',kind='family',label='C · staggered fan / longer settle',frames=108,zoom_start=.18,zoom_end=.65,layout='fan',distance=.82)]
if args.macro_pass:
 specs=[dict(name='entrance-b-macro',kind='entrance',label='B revised · strong visible roll',frames=96,macro=True,haze=False,axis_from_vertical=30,center_roll=55,axis_depth_tilt=35,roll_start=125,roll_end=-15,roll_window=[.25,.75])]
def ease(t,a=0,b=1):
 u=max(0,min(1,(t-a)/(b-a)));return u*u*(3-2*u)
def key(o):
 for p in ('location','rotation_euler'):o.keyframe_insert(p,frame=f)
for spec in specs:
 if args.shot and args.shot!=spec['name']:continue
 name=spec['name'];dest=OUT/name;dest.mkdir(exist_ok=True);family=spec['kind']=='family';scene.frame_start=1;scene.frame_end=spec['frames']
 for o in list(pivots.values())+[cam,sweep,fill,rim]:o.animation_data_clear()
 for product,objs in groups.items():
  for ob in objs:ob.hide_render=not family and product!='mini'
 sweep.data.animation_data_clear()
 floor.hide_render=not family;haze.hide_render=not spec.get('haze',False)
 camdata.lens=50 if family else 55;bg.inputs['Strength'].default_value=.11 if family else .015
 fill.data.energy=8 if family else .08;fill.data.size=.45 if family else .12;fill.data.size_y=.6 if family else .16;fill.location=(.15,-.25,.55) if family else (.12,-.10,.22);aim(fill,(0,0,0))
 rim.data.energy=10 if family else .15;rim.data.size=.4 if family else .10;rim.data.size_y=.5 if family else .2;rim.location=(-.25,.30,.5) if family else (-.12,.16,.12);aim(rim,(0,0,0))
 sweep.data.energy=9 if family else 2.1;sweep.data.size=.35 if family else .018;sweep.data.size_y=.6 if family else .18
 for f in range(1,spec['frames']+1):
  t=(f-1)/(spec['frames']-1)
  if spec.get('macro'):
   p=pivots['mini'];q=Quaternion((0,0,1),math.radians(60))@Quaternion((0,1,0),math.radians(35))@Quaternion((1,0,0),math.radians(125-140*ease(t,.25,.75)))
   p.rotation_euler=q.to_euler()
   logo=next(o for o in groups['mini'] if o.name.endswith('/logo-white-inlay'))
   corners=[Vector(v) for v in logo.bound_box];local=sum(corners,Vector())/8+logo.location
   target=Vector((.25*(t-.5),.075*(t-.5),0));p.location=target-q@local;key(p)
   cam.location=(0,0,.15);aim(cam,(0,0,0));key(cam)
   normal=q@Vector((0,0,1));view=Vector((0,0,1));reflection=2*normal.dot(view)*normal-view
   sweep.location=target+.16*(Quaternion(normal,math.radians(100*(t-.5)))@reflection);aim(sweep,target);key(sweep)
   sweep.data.size=.012;sweep.data.size_y=.10;sweep.data.energy=.28*(.12+.88*math.exp(-((t-.5)/.13)**2));sweep.data.keyframe_insert('energy',frame=f)
  elif not family:
   u=ease(t,0,spec['arrival']);p=pivots['mini'];p.location=(-.14*(1-u),-.105*(1-u),0)
   p.rotation_euler=(Quaternion((0,0,1),math.radians(45))@Quaternion((1,0,0),math.radians(spec['roll']+(spec['endroll']-spec['roll'])*u))).to_euler();key(p)
   cam.location=(0,0,.28);aim(cam,(0,0,0));key(cam)
   sweep.data.energy=2.1*ease(t,spec['light_start'],spec['light_start']+.25);sweep.data.keyframe_insert('energy',frame=f)
   a=ease(t,spec['light_start'],spec['light_end']);sweep.location=(-.19+.38*a,.035,.18);aim(sweep,p.location);key(sweep)
  else:
   layout=spec['layout'];mini=Vector((-.075,-.075,sizes['mini'].z/2));other=Vector((.055,-.075,sizes['splanc'].z/2));big=Vector((0,.085,sizes['max'].z/2))
   if layout=='line':mini.x=0;mini.y=0;other.x=.12;other.y=0;big.x=-.23;big.y=0
   if layout=='fan':mini.x=-.085;other.x=.055;big.y=.095
   z=ease(t,spec['zoom_start'],spec['zoom_end']);settle=ease(t,.12,.77)
   pivots['mini'].location=mini;pivots['mini'].rotation_euler=(0,0,math.radians(45*(1-settle)+(-7 if layout=='fan' else 0)*settle));key(pivots['mini'])
   for prod,final,sign,delay,angle in [('max',big,-1,0,-18),('splanc',other,1,.10 if layout=='line' else .035,24)]:
    a=ease(t,.10+delay,.74+delay);p=pivots[prod];p.location=final+Vector((sign*.60*(1-a),0,0));p.rotation_euler=(0,0,math.radians(angle*(1-a)**2+(6 if layout=='fan' and prod=='splanc' else 0)*a));key(p)
   target=mini.lerp(Vector((0,.02,.015)) if layout!='line' else Vector((-.116,0,.018)),z)
   distance=.068+(spec['distance']-.068)*z;cam.location=target+Vector((0,-.38*distance,distance));aim(cam,target);key(cam)
   sweep.location=(-.18,.10,.5);aim(sweep,(0,0,0));key(sweep)
 # Dense linear keys preserve the prescribed easing without overshoot.
 for o in list(pivots.values())+[cam,sweep]:
  if o.animation_data and o.animation_data.action:
   for fc in o.animation_data.action.fcurves:
    for k in fc.keyframe_points:k.interpolation='LINEAR'
 (dest/'shot.json').write_text(json.dumps(dict(spec,cad='compact-handheld-r9',fps=24,resolution=[640,360],samples=args.samples),indent=2))
 scene.render.image_settings.file_format='PNG'
 for frame in ([38,48,58] if spec.get('macro') and args.stills else [48] if spec.get('macro') else [round(spec['frames']*.55),spec['frames']] if args.stills else [spec['frames']]):
  scene.frame_set(frame);scene.render.filepath=str(dest/f'frame-{frame:03}.png');bpy.ops.render.render(write_still=True)
 if not args.stills:
  scene.render.image_settings.file_format='FFMPEG';scene.render.ffmpeg.format='MPEG4';scene.render.ffmpeg.codec='H264';scene.render.ffmpeg.constant_rate_factor='MEDIUM';scene.render.filepath=str(dest/(name+'.mp4'));bpy.ops.render.render(animation=True)
 print('COMPLETE',name,'stills' if args.stills else 'animation',flush=True)
(OUT/'catalog.json').write_text(json.dumps(specs,indent=2))
