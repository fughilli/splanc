"""HD campaign assets from frozen r11 family CAD. Run in Blender 4.5."""
import argparse, json, math, sys, time
from pathlib import Path
import bpy
from mathutils import Vector, Quaternion

R = Path.cwd()
O = R / 'output/advertising-kit-20261008'
ap = argparse.ArgumentParser()
ap.add_argument('--mode', choices=['stills', 'videos', 'preview', 'web'], default='stills')
ap.add_argument('--shot')
a = ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
O.mkdir(exist_ok=True)
for d in ['stills', 'video', 'blender', 'review']:
    (O/d).mkdir(exist_ok=True)
sys.path.insert(0, str(R/'hardware/mechanical'))
from ambient_materials import physical_uvs
cad = json.loads((R/'output/max-service-r11/scene.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(R/'output/blender-motion-studio-r4/splanc-motion-studio.blend'))
lib = bpy.data.scenes['03 · Family asset library']
original = {o.name:o for o in lib.objects if o.type == 'MESH'}
mats = {}
for i in cad['items']:
    ob = original.get(i['product']+'/'+i['name'])
    if ob and ob.data.materials:
        mats[i['material']] = list(ob.data.materials)
red = bpy.data.materials.new('XT150 red'); red.use_nodes=True
bs = red.node_tree.nodes.get('Principled BSDF')
bs.inputs['Base Color'].default_value=(.45,.007,.004,1)
bs.inputs['Roughness'].default_value=.38
mats['dc_red']=[red]
world = lib.world.copy()
s = bpy.data.scenes.new('Splanc campaign');s.world=world;bpy.context.window.scene=s
for old in list(bpy.data.scenes):
    if old != s: bpy.data.scenes.remove(old)
groups={}; pivots={}; sizes={};centers={}
for sku in ['mini','splanc','max']:
    items=[i for i in cad['items'] if i['product']==sku]
    verts=[v for i in items for v in i['vertices']]
    lo=Vector([min(v[k] for v in verts)*.001 for k in range(3)])
    hi=Vector([max(v[k] for v in verts)*.001 for k in range(3)])
    center=(lo+hi)/2;sizes[sku]=hi-lo;centers[sku]=center
    p=bpy.data.objects.new('Product / '+sku,None);s.collection.objects.link(p)
    pivots[sku]=p;groups[sku]=[]
    for i in items:
        me=bpy.data.meshes.new(sku+'/'+i['name'])
        me.from_pydata([[v*.001 for v in pt] for pt in i['vertices']],[],i['faces']);me.update()
        physical_uvs(me,i['material'])
        ob=bpy.data.objects.new(me.name,me);s.collection.objects.link(ob)
        ob['source_name']=i['name'];ob['source_material']=i['material']
        ob.parent=p;ob.location=-center
        for m in mats.get(i['material'],mats['nylon']):me.materials.append(m)
        bevel=ob.modifiers.new('Optical edges','BEVEL');bevel.width=.00006;bevel.segments=2;bevel.limit_method='ANGLE'
        ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
        groups[sku].append(ob)
def aim(o,target):o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
def area(name,loc,power,size):
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='RECTANGLE';d.size=size;d.size_y=size*1.7
    o=bpy.data.objects.new(name,d);s.collection.objects.link(o);o.location=loc;aim(o,(0,0,0));return o
key=area('Key softbox',(-.2,-.3,.45),18,.35)
rim=area('Cool rim',(.2,.25,.4),20,.3);rim.data.color=(.74,.84,1)
fill=area('Service fill',(-.3,.1,.18),7,.25)
cd=bpy.data.cameras.new('Camera');cam=bpy.data.objects.new('Camera',cd);s.collection.objects.link(cam);s.camera=cam
cd.clip_start=.001;cd.clip_end=20;cd.type='ORTHO'
# HDRI illuminates and reflects; camera sees black beyond the studio surface.
n=world.node_tree.nodes;l=world.node_tree.links
out=next(v for v in n if v.type=='OUTPUT_WORLD')
bg=next(v for v in n if v.type=='BACKGROUND' and v.inputs['Color'].is_linked);bg.inputs['Strength'].default_value=.12
black=n.new('ShaderNodeBackground');black.inputs['Color'].default_value=(.004,.005,.008,1);black.inputs['Strength'].default_value=.3
lp=n.new('ShaderNodeLightPath');mix=n.new('ShaderNodeMixShader')
l.new(lp.outputs['Is Camera Ray'],mix.inputs[0]);l.new(bg.outputs[0],mix.inputs[1]);l.new(black.outputs[0],mix.inputs[2]);l.new(mix.outputs[0],out.inputs['Surface'])
bpy.ops.mesh.primitive_plane_add(size=20,location=(0,0,-.03));floor=bpy.context.object;floor.name='Charcoal velvet'
velvet=bpy.data.materials.new('Charcoal velvet');velvet.use_nodes=True
bs=velvet.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.008,.011,.016,1);bs.inputs['Roughness'].default_value=.94;bs.inputs['Sheen Weight'].default_value=.4
floor.data.materials.append(velvet)
s.render.resolution_x=1920;s.render.resolution_y=1080;s.render.resolution_percentage=100;s.render.fps=24
s.view_settings.view_transform='AgX';s.view_settings.exposure=-.65
s.render.threads_mode='FIXED';s.render.threads=4
s.render.engine='CYCLES';s.cycles.samples=64;s.cycles.use_denoising=True;s.cycles.max_bounces=6;s.render.use_persistent_data=True
pref=bpy.context.preferences.addons['cycles'].preferences;pref.compute_device_type='METAL';pref.get_devices()
for d in pref.devices:d.use=d.type=='METAL'
s.cycles.device='GPU' if any(d.type=='METAL' for d in pref.devices) else 'CPU'
def show(sku):
    for prod,obs in groups.items():
        for o in obs:o.hide_render=sku!='family' and prod!=sku
def reset():
    for o in list(pivots.values())+[cam,key,rim,fill]:o.animation_data_clear()
    for p in pivots.values():p.location=(0,0,0);p.rotation_euler=(0,0,0)
    key.data.animation_data_clear();cd.animation_data_clear()
def still(path):
    s.render.image_settings.file_format='PNG';s.render.filepath=str(path)
    t=time.monotonic();bpy.ops.render.render(write_still=True)
    print('ASSET',path.name,round(time.monotonic()-t,2),flush=True)
if a.mode=='web':
    import numpy as np
    import bmesh
    from collections import defaultdict
    dest=O/'sim'/'models';dest.mkdir(parents=True,exist_ok=True)
    report={};topology=[]
    def port_anchors(sku):
        items=[i for i in cad['items'] if i['product']==sku]
        def bounds(prefix):
            v=[pt for i in items if i['name'].startswith(prefix) for pt in i['vertices']]
            return np.min(v,axis=0),np.max(v,axis=0)
        ports=[]
        def add(key,label,description,p,normal):
            ports.append(dict(id=key,label=label,description=description,position=list(Vector(p)*.001-centers[sku]),normal=normal))
        if sku in ['mini','splanc']:
            lo,hi=bounds('USB4105');p=(lo+hi)/2;p[1]=lo[1]
            add('usb','USB-C','USB-C power and USB data connection.',p,[0,-1,0])
            for n,prefix in enumerate(['JST-20','JST-31'] if sku=='mini' else ['board.led0.conn','board.led1.conn'],1):
                lo,hi=bounds(prefix);p=(lo+hi)/2;p[2]=hi[2]
                add(f'led-{n}',f'LED {n}',f'Addressable LED strip output {n}. Two strip outputs are provided on this module.',p,[0,0,1])
        else:
            for n in [1,2]:
                lo,hi=bounds(f'ethernet-panel-{n}');p=(lo+hi)/2;p[0]=lo[0]
                add(f'ethernet-{n}',f'Ethernet {n}','2× shielded Ethernet, daisy-chainable through the internal network switch. Connect the upstream network and the next unit here.',p,[-1,0,0])
            lo,hi=bounds('XT150');p=(lo+hi)/2;p[0]=lo[0]
            add('dc','DC power','Paired XT150 positive and return connectors. Powers the LED rail and the internal 5 V supply for the Raspberry Pi.',p,[-1,0,0])
            for row,start in enumerate([10,20]):
                v=[pt for i in items if any(i['name'].startswith(f'DEGSON-J{n}-') for n in range(start,start+10)) for pt in i['vertices']]
                lo=np.min(v,axis=0);hi=np.max(v,axis=0);p=(lo+hi)/2;p[1]=lo[1] if row==0 else hi[1]
                label=f'LED {row*10+1}–{row*10+10}'
                add(f'led-bank-{row}',label,'Ten addressable LED strip outputs in this bank; twenty total, with per-channel power switching and current telemetry in the MAX design.',p,[0,-1 if row==0 else 1,0])
        return ports
    def mesh_health(me):
        bm=bmesh.new();bm.from_mesh(me)
        result=dict(nonmanifold_edges=sum(not e.is_manifold for e in bm.edges),faces=len(bm.faces),volume=bm.calc_volume(signed=True))
        bm.free();return result
    def evaluated_mesh(ob):
        deps=bpy.context.evaluated_depsgraph_get()
        return bpy.data.meshes.new_from_object(ob.evaluated_get(deps),depsgraph=deps)
    for sku,objects in groups.items():
        bundles=defaultdict(list)
        for ob in objects:
            name=ob['source_name']
            visible=(name in ['base','lid','logo-white-inlay','seam-sealant'] or name.startswith(('USB4105','JST-','board.led0.conn','board.led1.conn','case-screw','lightpipe','button-shuttle','DEGSON','ethernet-panel','ethernet-mount-screw','XT150','dc-carrier')))
            if not visible:continue
            # CAD tessellation duplicates vertices at face boundaries. Weld seams
            # before simplifying, otherwise collapse can delete whole cap faces.
            bm=bmesh.new();bm.from_mesh(ob.data)
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-8)
            bm.to_mesh(ob.data);bm.free();ob.data.update()
            before=mesh_health(ob.data);dec=None
            # CAD already carries the enclosure fillets. A second bevel on every
            # connector triangle wastes bandwidth; retain it only on simple caps.
            ob.modifiers.clear()
            if name.startswith('button-shuttle'):
                bevel=ob.modifiers.new('Cap edge highlight','BEVEL');bevel.width=.00006;bevel.segments=2
            if before['faces']>500:
                dec=ob.modifiers.new('Web mesh budget','DECIMATE')
                if before['nonmanifold_edges']==0:
                    dec.ratio=.12 if name.startswith('ethernet-panel') else .65
                else:
                    # Vendor multi-solid tessellations can have shared/open edges.
                    # Dissolve coplanar interior edges without collapsing boundaries.
                    dec.decimate_type='DISSOLVE';dec.angle_limit=.005;dec.use_dissolve_boundaries=False
            me=evaluated_mesh(ob);after=mesh_health(me);fallback=False
            if before['nonmanifold_edges']==0 and (after['nonmanifold_edges'] or before['volume']*after['volume']<=0):
                # Preserve original tessellation if any display modifier opens it.
                bpy.data.meshes.remove(me);ob.modifiers.clear();me=evaluated_mesh(ob);after=mesh_health(me);fallback=True
                if after['nonmanifold_edges'] or before['volume']*after['volume']<=0:
                    raise RuntimeError(f'Closed web solid became open or inverted: {sku}/{name}')
            topology.append(dict(product=sku,part=name,before=before,after=after,fallback=fallback,decimated=bool(dec) and not fallback))
            me.calc_loop_triangles()
            pos=np.array([tuple(v.co+ob.location) for v in me.vertices],dtype='<f4')
            indices=np.array([tuple(t.loops) for t in me.loop_triangles],dtype=np.int32).reshape(-1)
            lv=np.array([l.vertex_index for l in me.loops],dtype=np.int32)
            normals=np.array([tuple(n.vector) for n in me.corner_normals],dtype='<f4')
            arr=np.concatenate((pos[lv[indices]],normals[indices]),axis=1)
            key=ob['source_material']
            bundles[key].append(arr);bpy.data.meshes.remove(me)
        blob=bytearray();parts=[]
        for mat,arrays in bundles.items():
            vertices,index=np.unique(np.round(np.concatenate(arrays),6),axis=0,return_inverse=True)
            vertices=np.asarray(vertices,dtype='<f4');index=np.asarray(index,dtype='<u4')
            offset=len(blob);blob.extend(vertices.tobytes());idxoffset=len(blob);blob.extend(index.tobytes())
            parts.append(dict(material=mat,offset=offset,vertices=len(vertices),indexOffset=idxoffset,indices=len(index)))
        (dest/(sku+'.bin')).write_bytes(blob)
        manifest=dict(product=sku,revision='max-service-r11',size=list(sizes[sku]),ports=port_anchors(sku),parts=parts,bytes=len(blob))
        (dest/(sku+'.json')).write_text(json.dumps(manifest));report[sku]=manifest
    env=next(n.image for n in world.node_tree.nodes if n.type=='TEX_ENVIRONMENT')
    copy=env.copy();copy.scale(1024,512);s.render.image_settings.file_format='JPEG';copy.save_render(str(dest/'environment.jpg'),scene=s)
    (O/'review'/'web-models.json').write_text(json.dumps(report,indent=2))
    (O/'review'/'web-topology.json').write_text(json.dumps(topology,indent=2))
elif a.mode=='stills':
    for sku in groups:
        show(sku);reset();w=sizes[sku].x;h=sizes[sku].y
        floor.hide_render=False;floor.location.z=-sizes[sku].z/2-.0002
        for angle,loc in [('hero',(-1,-1.35,1.05)),('ports',(1.2,-1.4,.60)),('reverse',(1,1.3,.9)),('top',(0,-.001,2))]:
            if sku=='max' and angle=='ports':loc=(-1.5,-.45,.55)
            cam.location=Vector(loc)*w;aim(cam,(0,0,0));cd.ortho_scale=max(w*1.32,h*1.78*1.22)
            still(O/'stills'/f'{sku}-{angle}.png')
    show('family');reset();floor.location.z=-.0002
    for sku,pos in [('mini',(-.075,-.08)),('splanc',(.065,-.08)),('max',(0,.08))]:pivots[sku].location=(*pos,sizes[sku].z/2)
    cam.location=(.05,-.65,.6);aim(cam,(0,.015,.01));cd.ortho_scale=.57
    still(O/'stills'/'family.png')
    bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(O/'blender'/'family-studio.blend'),compress=True)
else:
    # Full-HD real-time masters; stills retain the path-traced treatment.
    s.render.engine='BLENDER_EEVEE_NEXT';s.eevee.taa_render_samples=48
    shots=[(k+'-orbit',k,96) for k in groups]+[('mini-macro-roll','mini',96),('family-pullback','family',120)]
    def ease(t):return t*t*(3-2*t)
    def record(o):
        o.keyframe_insert('location',frame=f);o.keyframe_insert('rotation_euler',frame=f)
    for name,sku,frames in shots:
        if a.shot and a.shot!=name:continue
        reset();show(sku);s.frame_start=1;s.frame_end=frames
        floor.hide_render=name=='mini-macro-roll';floor.location.z=-sizes.get(sku,Vector((0,0,0))).z/2-.0002
        for f in range(1,frames+1):
            t=(f-1)/(frames-1)
            if name.endswith('orbit'):
                w=sizes[sku].x;h=sizes[sku].y;theta=math.radians(-145+110*ease(t))
                cam.location=(math.cos(theta)*w*1.9,math.sin(theta)*w*1.9,w*(.9+.15*math.sin(t*math.pi)))
                aim(cam,(0,0,0));cd.ortho_scale=max(w*1.42,h*1.78*1.3)
                key.location=(-.25+.5*t,-.2,.4);aim(key,(0,0,0));record(key)
            elif name=='mini-macro-roll':
                p=pivots['mini'];q=Quaternion((0,0,1),math.radians(60))@Quaternion((0,1,0),math.radians(35))@Quaternion((1,0,0),math.radians(125-140*ease(t)))
                p.rotation_euler=q.to_euler();p.location=(.24*(t-.5),.09*(t-.5),0);record(p)
                cam.location=(0,0,.2);aim(cam,(0,0,0));cd.ortho_scale=.12
                normal=q@Vector((0,0,1));v=Vector((0,0,1));reflection=2*normal.dot(v)*normal-v
                key.location=p.location+.2*(Quaternion(normal,math.radians(80*(t-.5)))@reflection);aim(key,p.location);record(key)
                key.data.energy=.7+1.8*math.exp(-((t-.5)/.12)**2);key.data.keyframe_insert('energy',frame=f)
            else:
                floor.location.z=-.0002;u=ease(min(1,max(0,(t-.12)/.60)))
                for prod,final,sign in [('mini',(-.075,-.08),0),('splanc',(.065,-.08),1),('max',(0,.08),-1)]:
                    p=pivots[prod];p.location=(final[0]+sign*.60*(1-u),final[1],sizes[prod].z/2);p.rotation_euler=(0,0,math.radians(sign*26*(1-u)));record(p)
                target=Vector((-.075,-.08,.012)).lerp(Vector((0,.01,.014)),u)
                cam.location=target+Vector((0,-.65,.6));aim(cam,target);cd.ortho_scale=.052+(.57-.052)*u
            record(cam);cd.keyframe_insert('ortho_scale',frame=f)
        for o in list(pivots.values())+[cam,key,cd,key.data]:
            if o.animation_data and o.animation_data.action:
                for fc in o.animation_data.action.fcurves:
                    for kp in fc.keyframe_points:kp.interpolation='LINEAR'
        for f in [round(frames*.25),round(frames*.5),round(frames*.75)]:
            s.frame_set(f);still(O/'review'/f'{name}-{f:03}.png')
        if a.mode=='preview':continue
        bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(O/'blender'/f'{name}.blend'),compress=True)
        s.render.image_settings.file_format='FFMPEG';s.render.ffmpeg.format='MPEG4';s.render.ffmpeg.codec='H264';s.render.ffmpeg.constant_rate_factor='HIGH';s.render.ffmpeg.ffmpeg_preset='GOOD';s.render.filepath=str(O/'video'/f'{name}.mp4')
        bpy.ops.render.render(animation=True)
        print('VIDEO COMPLETE',name,flush=True)
