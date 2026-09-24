"""Pack editable sparse-key camera/product/light rigs and current family assets."""
import sys
from pathlib import Path
sys.argv=[sys.argv[0]]
source=(Path.cwd()/'hardware/mechanical/render_motion_candidates.py').read_text().split('\nspecs=[')[0]
source=source.replace('output/button-dfa-r5/scene.json','output/compact-handheld-r9/scene.json')
exec(source)
OUT=ROOT/'output/blender-motion-studio-r4';OUT.mkdir(exist_ok=True)
# Retain shared mesh/material assets in their own scene; each shot gets independent rigs.
scene.name='03 · Family asset library'
floor.hide_render=True;haze.hide_render=True
for p,x in zip(('mini','splanc','max'),(-.23,-.09,.18)):pivots[p].location=(x,0,0)
cam.location=(0,-.55,1.1);aim(cam,(0,0,0))
lib=scene
for name,macro in [('01 · Entry B',False),('02 · Macro roll',True)]:
 sc=bpy.data.scenes.new(name);bpy.context.window.scene=sc;sc.world=lib.world.copy();sc.render.engine='CYCLES';sc.cycles.samples=32;sc.cycles.use_denoising=True
 sc.render.resolution_x=1920;sc.render.resolution_y=1080;sc.render.resolution_percentage=100;sc.render.fps=24;sc.frame_end=96 if macro else 84;sc.view_settings.view_transform='AgX';sc.view_settings.exposure=-.5
 sc.unit_settings.system='METRIC';sc.unit_settings.length_unit='MILLIMETERS'
 def empty(n,loc):
  o=bpy.data.objects.new(n,None);sc.collection.objects.link(o);o.location=loc;o.empty_display_type='PLAIN_AXES';o.empty_display_size=.012;return o
 root=empty('PRODUCT · translate and roll',(0,0,0));root.rotation_mode='XYZ'
 logo=next(o for o in groups['mini'] if o.name.endswith('/logo-white-inlay'))
 pivot=sum((Vector(v) for v in logo.bound_box),Vector())/8+logo.location if macro else Vector()
 for original in groups['mini']:
  o=original.copy();o.data=original.data;sc.collection.objects.link(o);o.parent=root;o.location=original.location-pivot;o.hide_render=False;o.hide_select=True
 target=empty('CAMERA TARGET · move to reframe',(0,0,0))
 camera=bpy.data.objects.new('CAMERA · editable dolly keys',camdata.copy());sc.collection.objects.link(camera);sc.camera=camera;camera.location=(0,0,.15 if macro else .28)
 con=camera.constraints.new('TRACK_TO');con.name='Aim at CAMERA TARGET';con.target=target;con.track_axis='TRACK_NEGATIVE_Z';con.up_axis='UP_Y'
 for f in [1,round(sc.frame_end/2),sc.frame_end]:
  camera.keyframe_insert('location',frame=f);camera.data.keyframe_insert('lens',frame=f);target.keyframe_insert('location',frame=f)
 poses=[(1,(-.14,-.105,0),100),(45,(0,0,0),18),(84,(0,0,0),18)]
 if macro:poses=[(1,(-.125,-.0375,0),125),(25,(-.062,-.0186,0),125),(48,(0,0,0),55),(72,(.062,.0186,0),-15),(96,(.125,.0375,0),-15)]
 for f,loc,roll in poses:
  root.location=loc;root.rotation_euler=(Quaternion((0,0,1),math.radians(60 if macro else 45))@Quaternion((0,1,0),math.radians(35 if macro else 0))@Quaternion((1,0,0),math.radians(roll))).to_euler()
  root.keyframe_insert('location',frame=f);root.keyframe_insert('rotation_euler',frame=f)
 for fc in root.animation_data.action.fcurves:
  if fc.data_path=='location' and macro:
   for k in fc.keyframe_points:k.interpolation='LINEAR'
  else:
   for k in fc.keyframe_points:k.handle_left_type='AUTO_CLAMPED';k.handle_right_type='AUTO_CLAMPED'
 for original in (sweep,fill,rim):
  o=original.copy();o.data=original.data.copy();o.animation_data_clear();sc.collection.objects.link(o)
  if original==sweep:
   o.name='LIGHT · highlight sweep';o.data.size=.012 if macro else .018;o.data.size_y=.1 if macro else .18
   for f in [1,round(sc.frame_end/2),sc.frame_end]:
    t=(f-1)/(sc.frame_end-1)
    sc.frame_set(f);bpy.context.view_layer.update()
    q=root.rotation_euler.to_quaternion();n=q@Vector((0,0,1));v=Vector((0,0,1));r=2*n.dot(v)*n-v
    o.location=root.location+.16*r if macro else Vector((-.19+.38*t,.035,.18))
    aim(o,root.location);o.data.energy=.28 if macro and f==48 else .03 if macro else 2.1*t
    o.keyframe_insert('location',frame=f);o.keyframe_insert('rotation_euler',frame=f);o.data.keyframe_insert('energy',frame=f)
  else:o.data.energy=.08 if original==fill else .15
 sc.timeline_markers.new('ENTRY',frame=1);sc.timeline_markers.new('LOGO / LIGHT',frame=48 if macro else 44);sc.timeline_markers.new('EXIT' if macro else 'SETTLE',frame=sc.frame_end)
 sc.frame_set(48 if macro else 44)
 for ob in (root,camera,target):ob['editing_note']='Use Timeline/Graph Editor. Camera has independent location/lens keys; target controls aim. Product roll is on PRODUCT.'
 sc.render.image_settings.file_format='FFMPEG';sc.render.ffmpeg.format='MPEG4';sc.render.ffmpeg.codec='H264';sc.render.filepath='//renders/'+('macro-roll' if macro else 'entry-b')+'.mp4'
text=bpy.data.texts.new('START HERE · Camera editing')
text.write('''SPLANC MOTION STUDIO\n\nUse the Scene dropdown to select 01 Entry B or 02 Macro roll.\n03 Family asset library contains the updated Mini, Splanc/GNSS and compact MAX.\n\nCAMERA: select CAMERA · editable dolly keys. G moves; I inserts keys.\nLens keys are in Camera Data > Lens. Existing keys at start/middle/end.\nCAMERA TARGET: move this empty to change the aim point.\nPRODUCT: select PRODUCT · translate and roll for motion and long-axis roll.\nLIGHT: select LIGHT · highlight sweep for independent position/energy keys.\nUse Timeline markers for entry, logo highlight and exit.\nNumpad 0 enters camera view. Space plays/scrubs animation.\nSolid/material preview is fast; F12 renders one frame; Ctrl-F12 renders video.\nChange resolution/samples in Output/Render Properties for quick trials.\nAll textures/HDRI are packed. Units are meters internally, displayed in mm.\nMeshes are protected from accidental selection; use Outliner to unlock if needed.\nSparse editable curves approximate the previously rendered candidates.\nMechanical r9 is a fit prototype, not tooling-qualified.\n''')
# Camera view on open, and select the camera so its curves are easy to find.
bpy.context.window.scene=bpy.data.scenes['02 · Macro roll'];sc=bpy.context.scene
for o in sc.objects:o.select_set(False)
sc.camera.select_set(True);bpy.context.view_layer.objects.active=sc.camera
for screen in bpy.data.screens:
 for area in screen.areas:
  if area.type=='VIEW_3D':area.spaces.active.region_3d.view_perspective='CAMERA';area.spaces.active.clip_start=.001;area.spaces.active.clip_end=100
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'splanc-motion-studio.blend'),compress=True)
# Render two proof frames without altering the packed project's quality settings.
for name in ['01 · Entry B','02 · Macro roll']:
 bpy.context.window.scene=bpy.data.scenes[name];sc=bpy.context.scene;sc.cycles.samples=6;sc.render.resolution_percentage=33;sc.render.image_settings.file_format='PNG';sc.render.filepath=str(OUT/('entry-b.png' if name.startswith('01') else 'macro-roll.png'));bpy.ops.render.render(write_still=True)
print('SAVED MOTION STUDIO',flush=True)
bpy.context.window.scene=lib;lib.cycles.samples=6;lib.render.resolution_x=900;lib.render.resolution_y=600;lib.render.resolution_percentage=100;lib.render.image_settings.file_format='PNG';lib.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.15
for lamp in (sweep,fill,rim):lamp.data.energy=8;lamp.data.size=.25;lamp.data.size_y=.4
sweep.location=(.1,.15,.4);aim(sweep,(0,0,0));fill.location=(.1,-.2,.35);aim(fill,(0,0,0));rim.location=(-.2,.1,.3);aim(rim,(0,0,0))
for product in ('mini','splanc','max'):
 for p,obs in groups.items():
  pivots[p].location=(0,0,0)
  for ob in obs:ob.hide_render=p!=product
 cam.location=(.14,-.18,.20) if product!='max' else (.31,.38,.34);aim(cam,(0,0,0));lib.render.filepath=str(OUT/(product+'-r9.png'));bpy.ops.render.render(write_still=True)
