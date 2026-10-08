"""Render MAX r11 using packed, previously approved materials and HDRI."""
from pathlib import Path
import sys,json,time
import bpy
from mathutils import Vector
R=Path.cwd();O=R/'output/max-service-r11';sys.path.insert(0,str(R/'hardware/mechanical'))
from ambient_materials import physical_uvs
cad=json.loads((O/'scene.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(R/'output/blender-motion-studio-r4/splanc-motion-studio.blend'))
lib=bpy.data.scenes['03 · Family asset library'];old_scenes=list(bpy.data.scenes)
original={o.name:o for o in lib.objects if o.type=='MESH'}
materials={}
for i in cad['items']:
 o=original.get(i['product']+'/'+i['name'])
 if o and o.data.materials:materials[i['material']]=list(o.data.materials)
red=bpy.data.materials.new('XT150 positive red housing');red.use_nodes=True;bs=red.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.45,.007,.004,1);bs.inputs['Roughness'].default_value=.38;materials['dc_red']=[red]
world=lib.world.copy();nodes=world.node_tree.nodes;links=world.node_tree.links
wo=next(n for n in nodes if n.type=='OUTPUT_WORLD');bg=next(n for n in nodes if n.type=='BACKGROUND' and n.inputs['Color'].is_linked)
bg.inputs['Strength'].default_value=.18
for l in list(wo.inputs['Surface'].links):links.remove(l)
links.new(bg.outputs['Background'],wo.inputs['Surface'])
s=bpy.data.scenes.new('MAX r11 service end');s.world=world;bpy.context.window.scene=s
s.render.engine='CYCLES';s.cycles.samples=48;s.cycles.use_denoising=True;s.render.threads_mode='FIXED';s.render.threads=4
p=bpy.context.preferences.addons['cycles'].preferences;p.compute_device_type='METAL';p.get_devices()
for d in p.devices:d.use=d.type=='METAL'
s.cycles.device='GPU' if any(d.type=='METAL' for d in p.devices) else 'CPU'
s.render.resolution_x=1600;s.render.resolution_y=1000;s.render.resolution_percentage=100;s.render.image_settings.file_format='PNG'
s.view_settings.view_transform='AgX';s.view_settings.exposure=-1.0
obs=[]
for i in cad['items']:
 if i['product']!='max':continue
 name=i['name'];me=bpy.data.meshes.new(name);me.from_pydata([[v*.001 for v in a] for a in i['vertices']],[],i['faces']);me.update();physical_uvs(me,i['material'])
 ob=bpy.data.objects.new(name,me);s.collection.objects.link(ob)
 for m in materials.get(i['material'],materials['nylon']):me.materials.append(m)
 ob['part_name']=name;ob['note']=i.get('note','');obs.append(ob)
 bevel=ob.modifiers.new('Optical edge rounding','BEVEL');bevel.width=.00006;bevel.segments=2;bevel.limit_method='ANGLE'
 ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
def aim(o,pt):o.rotation_euler=(Vector(pt)-o.location).to_track_quat('-Z','Y').to_euler()
center=Vector((.165,.067,.0215))
for name,loc,power,size in [('Key',(-.1,-.25,.45),14,.4),('Rim',(.4,.3,.5),13,.3),('Service fill',(-.15,.2,.14),7,.3)]:
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);s.collection.objects.link(o);o.location=loc;aim(o,center)
mat=bpy.data.materials.new('Charcoal studio');mat.diffuse_color=(.035,.045,.055,1)
bpy.ops.mesh.primitive_plane_add(size=4,location=(0,0,-.00025));bpy.context.object.data.materials.append(mat)
cd=bpy.data.cameras.new('Review camera');cam=bpy.data.objects.new(cd.name,cd);s.collection.objects.link(cam);s.camera=cam;cd.type='ORTHO';cd.clip_start=.001;cd.clip_end=10
report={}
for name,loc,target,scale in [('max-hero',(-.22,-.26,.28),center,.44),('max-service-end',(-.20,-.02,.115),(.025,.067,.024),.17),('max-internal',(.1,-.21,.42),center,.43)]:
 for o in obs:o.hide_render=name=='max-internal' and o.name in ('lid','logo-white-inlay','seam-sealant')
 cam.location=loc;aim(cam,target);cd.ortho_scale=scale;s.render.filepath=str(O/(name+'.png'))
 start=time.monotonic();bpy.ops.render.render(write_still=True);report[name]={'seconds':time.monotonic()-start,'image':s.render.filepath}
for o in obs:o.hide_render=False
cam.location=(-.22,-.26,.28);aim(cam,center);cd.ortho_scale=.44
for old in old_scenes:bpy.data.scenes.remove(old)
bpy.data.orphans_purge(do_recursive=True);bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(O/'max-service-studio.blend'),compress=True)
(O/'render-validation.json').write_text(json.dumps({'revision':'max-service-r11','device':s.cycles.device,'renders':report},indent=2))
