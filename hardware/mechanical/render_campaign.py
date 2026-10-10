"""Blender Cycles studio render of CAD meshes, no generative geometry.
blender -b --python render_products.py -- output/product-renders/scene.json
"""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from ambient_materials import apply_ambient_materials, physical_uvs, setup_hdri
root=Path(sys.argv[sys.argv.index('--')+1]).resolve();data=json.loads(root.read_text());out=root.parent
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def material(name,color,metal=0,rough=.4,trans=0,noise=False):
 m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes;bs=n.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=rough;bs.inputs['Transmission Weight'].default_value=trans
 if trans:bs.inputs['IOR'].default_value=1.49
 if noise:
  coord=n.new('ShaderNodeTexCoord');tex=n.new('ShaderNodeTexNoise');m.node_tree.links.new(coord.outputs['Object'],tex.inputs['Vector']);tex.inputs['Scale'].default_value=5500;tex.inputs['Detail'].default_value=2
  bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.27;bump.inputs['Distance'].default_value=.000045;m.node_tree.links.new(tex.outputs['Fac'],bump.inputs['Height']);m.node_tree.links.new(bump.outputs['Normal'],bs.inputs['Normal'])
 return m
mats={
 'shell_base':material('Textured black PC-ABS base',(.008,.009,.011),rough=.48,noise=True),
 'shell_lid':material('Textured black PC-ABS lid',(.008,.009,.011),rough=.48,noise=True),
 'fastener':material('Brushed stainless fasteners',(.32,.35,.38),metal=1,rough=.3),
 'seal':material('Dark silicone sealing gasket',(.035,.05,.055),rough=.65),
 'logo_white':material('White second-shot plastic inlay',(.8,.8,.78),rough=.36),
 'button':material('Splanc blue silicone',(.009,.08,.62),rough=.44,noise=True),
 'lightpipe':material('Translucent turquoise PMMA',(.025,.62,.48),rough=.18,trans=.65),
 'pcb':material('Dark green solder mask',(.012,.075,.045),rough=.48),
 'nickel':material('Nickel-plated connector steel',(.55,.60,.64),metal=1,rough=.23),
 'gold':material('Gold connector contacts',(.83,.55,.18),metal=1,rough=.23),
 'nylon':material('Black connector LCP',(.008,.011,.014),rough=.34),
 'white_nylon':material('Ivory JST housing',(.75,.72,.61),rough=.38),
 'terminal':material('Green terminal PA66',(.026,.28,.09),rough=.34),
 'copper':material('Copper busbar',(.66,.27,.105),metal=1,rough=.25),
 'antenna':material('RF ceramic',(.63,.58,.47),rough=.57)}
apply_ambient_materials(mats, Path('output/ambientcg'))
groups={}
for i in data['items']:
 verts=[tuple(v*.001 for v in xyz) for xyz in i['vertices']];me=bpy.data.meshes.new(i['name']);me.from_pydata(verts,[],i['faces']);me.update();ob=bpy.data.objects.new(i['product']+'/'+i['name'],me);bpy.context.collection.objects.link(ob);ob.data.materials.append(mats.get(i['material'],mats['nylon']));physical_uvs(me,i['material']);groups.setdefault(i['product'],[]).append(ob)
 # Preserve CAD normals: autosmoothing only smooth faces with near-coplanar triangles.
 for p in me.polygons:p.use_smooth=False
 bevel=ob.modifiers.new('Small optical edge rounding','BEVEL');bevel.width=.00008;bevel.segments=2;bevel.limit_method='ANGLE'
 bevel.angle_limit=.65
 ob.modifiers.new('Weighted surface normals','WEIGHTED_NORMAL')
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True;scene.render.threads_mode='FIXED';scene.render.threads=4
scene.render.resolution_x=2000;scene.render.resolution_y=1500;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.world.color=(.22,.22,.22)
scene.view_settings.view_transform='AgX';scene.view_settings.exposure=-1.3;scene.render.film_transparent=False
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.00025));floor=bpy.context.object;floor.name='Studio ground';floor.data.materials.append(material('Warm gray studio',(.045,.055,.065),rough=.65))
def aim(ob,target):ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
lights=[]
for name,loc,power,size in [('Key',(-.25,-.35,.5),8,.4),('Rim',(.3,.3,.5),12,.3),('Fill',(.4,-.1,.15),4,.3)]:
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o);o.location=loc;aim(o,(0,0,0));lights.append(o)
 if name=='Rim':o.name='Highlight Sweep';o['animation_role']='Move around product for controlled highlight sweep'
setup_hdri(scene,Path('output/ambientcg/IndoorEnvironmentHDRI002_4K/IndoorEnvironmentHDRI002_4K_HDR.exr'))
camdata=bpy.data.cameras.new('Studio camera');cam=bpy.data.objects.new('Studio camera',camdata);bpy.context.collection.objects.link(cam);scene.camera=cam;camdata.type='ORTHO';camdata.lens=55
render_args=sys.argv[sys.argv.index('--')+2:]
hero_only='--hero-only' in render_args
preview='--preview' in render_args
if preview:scene.render.resolution_x=1000;scene.render.resolution_y=750;scene.cycles.samples=24
selected=set(a for a in render_args if not a.startswith('--'))
for product,objs in groups.items():
 if selected and product not in selected:continue
 for name,other in groups.items():
  for ob in other:ob.hide_render=name!=product
 points=[ob.matrix_world@Vector(v) for ob in objs for v in ob.bound_box];lo=Vector(tuple(min(p[k] for p in points) for k in range(3)));hi=Vector(tuple(max(p[k] for p in points) for k in range(3)));center=(lo+hi)/2;span=max(hi.x-lo.x,hi.y-lo.y)
 cam.location=center+Vector((span*.9,-span*1.25,span*1.1));aim(cam,center);camdata.ortho_scale=span*1.55;camdata.clip_start=.001;camdata.clip_end=100
 scene.render.filepath=str(out/(product+'-hero.png'));bpy.ops.render.render(write_still=True)
 # A second angle shows the connector edge with a lower camera.
 if not hero_only:
  cam.location=center+Vector((-span*.75,-span*1.4,span*.67));aim(cam,center);scene.render.filepath=str(out/(product+'-ports.png'));bpy.ops.render.render(write_still=True)
for name,other in groups.items():
 delta={'mini':(-.01,-.12,0),'splanc':(.10,-.13,0),'max':(-.025,.025,0)}[name.replace('-weather','')]
 for ob in other:ob.hide_render=name.endswith('-weather');ob.location=delta
cam.location=(.49,-.51,.49);aim(cam,(.145,.03,.018));camdata.ortho_scale=.56
scene.render.resolution_x=2000;scene.render.resolution_y=1500;scene.render.filepath=str(out/'family.png')
if '--no-family' not in render_args:bpy.ops.render.render(write_still=True)
# Keep each product in a separate collection in the reusable Blender asset file.
for name,objs in groups.items():
 col=bpy.data.collections.new(name.upper());scene.collection.children.link(col)
 for ob in objs:
  for old in list(ob.users_collection):old.objects.unlink(ob)
  col.objects.link(ob)
for name,objs in groups.items():
 pivot=bpy.data.objects.new('Turntable / '+name,None);scene.collection.objects.link(pivot);pivot.empty_display_type='PLAIN_AXES'
 points=[ob.matrix_world@Vector(v) for ob in objs for v in ob.bound_box]
 pivot.location=tuple((min(p[k] for p in points)+max(p[k] for p in points))/2 for k in range(3))
 for ob in objs:
  world=ob.matrix_world.copy();ob.parent=pivot;ob.matrix_world=world
 pivot['animation_role']='Product orbit pivot; animate Z rotation and camera independently'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(out/'splanc-products.blend'))
validation={'materials':{key:{'name':m.name,'tile_size_m':m.get('tile_size_m'),'mapping':m.get('mapping'),'grain_wavelength_mm':m.get('grain_wavelength_mm'),'images':[{'name':n.image.name,'packed':bool(n.image.packed_file)} for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]} for key,m in mats.items()},'hdri':scene.world.get('source'),'packed_images':len([i for i in bpy.data.images if i.packed_file]),'resolution':[2000,1500],'motion_rigs':[o.name for o in bpy.data.objects if o.name.startswith('Turntable /') or o.name=='Highlight Sweep']}
validation['uv_bounds']={ob.name:[min(v.uv.x for v in ob.data.uv_layers.active.data),max(v.uv.x for v in ob.data.uv_layers.active.data),min(v.uv.y for v in ob.data.uv_layers.active.data),max(v.uv.y for v in ob.data.uv_layers.active.data)] for objs in groups.values() for ob in objs if ob.data.uv_layers.active}
assert all(0<=min(bounds) and max(bounds)<=1 for bounds in validation['uv_bounds'].values()),'Plastic UVs must fit a single texture swatch'
(out/'render-validation.json').write_text(json.dumps(validation,indent=2)+'\n')
print('Rendered products:',','.join(groups))
