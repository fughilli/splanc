"""Exact user-selected ambientCG maps, physical-scale UVs and HDRI setup."""
import bpy,math
# One 350 mm swatch, shared across products and all maps. MAX is 335 mm long.
TILES={key:.350 for key in ('shell_base','shell_lid','logo_white','button')}
def physical_uvs(me,key):
 if key not in TILES:return
 uv=me.uv_layers.new(name='PhysicalScaleUV');scale=TILES[key]
 for poly in me.polygons:
  axis=max(range(3),key=lambda i:abs(poly.normal[i]));axes=((1,2),(0,2),(0,1))[axis]
  for index in poly.loop_indices:
   v=me.vertices[me.loops[index].vertex_index].co;uv.data[index].uv=((v[axes[0]]+.005)/scale,(v[axes[1]]+.005)/scale)
def apply_ambient_materials(mats,root):
 for key,asset in [('shell_base','Plastic012B'),('shell_lid','Plastic012B'),('logo_white','Plastic013A'),('button','Plastic016A')]:
  m=mats[key];m.name=asset+' / '+key;m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links;n.clear();out=n.new('ShaderNodeOutputMaterial');bs=n.new('ShaderNodeBsdfPrincipled');l.new(bs.outputs['BSDF'],out.inputs['Surface']);bs.inputs['IOR'].default_value=1.46
  if key.startswith('shell_'):
   m.name='Clean fine labyrinth plastic / '+key
   bs.inputs['Base Color'].default_value=(.012,.013,.014,1)
   bs.inputs['Roughness'].default_value=.48
   # Blend scalar heights before differentiating: tangent normals cannot be
   # box-projected directly because their frames rotate between cube faces.
   coord=n.new('ShaderNodeTexCoord');mapping=n.new('ShaderNodeVectorMath');mapping.operation='SCALE';mapping.inputs[3].default_value=1/TILES[key]
   l.new(coord.outputs['Object'],mapping.inputs[0])
   offset=n.new('ShaderNodeVectorMath');offset.operation='ADD';offset.inputs[1].default_value=(.005/TILES[key],)*3;l.new(mapping.outputs['Vector'],offset.inputs[0])
   tex=n.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str((root.parent/'clean-plastic'/'height.png').resolve()),check_existing=True);tex.image.colorspace_settings.name='Non-Color'
   tex.projection='BOX';tex.projection_blend=.3;tex.extension='EXTEND';l.new(offset.outputs['Vector'],tex.inputs['Vector'])
   bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=1;bump.inputs['Distance'].default_value=.000012
   l.new(tex.outputs['Color'],bump.inputs['Height']);l.new(bump.outputs['Normal'],bs.inputs['Normal'])
   m['source']='generate_clean_plastic.py; scratch-free spectral labyrinth'
   m['tile_size_m']=TILES[key];m['grain_wavelength_mm']=.30
   m['mapping']='object-space blended box height; normals from height derivatives'
   continue
  maps={}
  for kind in ('Color','Roughness','NormalGL'):
   path=root/(asset+'_2K-JPG')/(asset+'_2K-JPG_'+kind+'.jpg');tex=n.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(path.resolve()),check_existing=True);tex.image.colorspace_settings.name='sRGB' if kind=='Color' else 'Non-Color';tex.label=asset+' '+kind;maps[kind]=tex
  if key.startswith('shell_'):
   tint=n.new('ShaderNodeMixRGB');tint.blend_type='MULTIPLY';tint.inputs[0].default_value=1;tint.inputs[2].default_value=(.35,.35,.35,1);l.new(maps['Color'].outputs['Color'],tint.inputs[1]);l.new(tint.outputs[0],bs.inputs['Base Color'])
  else:l.new(maps['Color'].outputs['Color'],bs.inputs['Base Color'])
  l.new(maps['Roughness'].outputs['Color'],bs.inputs['Roughness'])
  normal=n.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.25;l.new(maps['NormalGL'].outputs['Color'],normal.inputs['Color']);l.new(normal.outputs['Normal'],bs.inputs['Normal'])
  m['ambientcg_source']='https://ambientcg.com/view?id='+asset;m['tile_size_m']=TILES[key];m['license']='CC0'
 # Frosted neutral PMMA, with a subtle illuminated core beneath the exposed end.
 m=mats['lightpipe'];m.name='Semi-frosted translucent PMMA';bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.74,.86,.85,1);bs.inputs['Transmission Weight'].default_value=.78;bs.inputs['Roughness'].default_value=.32;bs.inputs['IOR'].default_value=1.49;bs.inputs['Subsurface Weight'].default_value=.06
 bs.inputs['Emission Color'].default_value=(.08,.35,.25,1);bs.inputs['Emission Strength'].default_value=.15
 m['finish']='fine frosted end / translucent neutral PMMA, provisional optical material'
def setup_hdri(scene,path):
 scene.world.use_nodes=True;n=scene.world.node_tree.nodes;l=scene.world.node_tree.links;n.clear()
 env=n.new('ShaderNodeTexEnvironment');env.image=bpy.data.images.load(str(path.resolve()),check_existing=True)
 env.texture_mapping.rotation[2]=math.radians(35)
 bg=n.new('ShaderNodeBackground');bg.inputs['Strength'].default_value=.15;out=n.new('ShaderNodeOutputWorld');l.new(env.outputs['Color'],bg.inputs['Color']);l.new(bg.outputs['Background'],out.inputs['Surface'])
 scene.world['source']='https://ambientcg.com/view?id=IndoorEnvironmentHDRI002';scene.world['license']='CC0'
