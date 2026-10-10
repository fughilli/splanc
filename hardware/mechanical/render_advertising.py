"""HD campaign assets from frozen r11 family CAD. Run in Blender 4.5."""
import argparse, json, math, sys, time
from pathlib import Path
import bpy
from mathutils import Vector, Quaternion

R = Path.cwd()
ap = argparse.ArgumentParser()
ap.add_argument('--mode', choices=['stills', 'videos', 'preview', 'web'], default='stills')
ap.add_argument('--shot')
ap.add_argument('--output', default='output/advertising-kit-20261008')
ap.add_argument('--engine', choices=['cycles','eevee'], default='cycles', help='Cycles is required for final recess/contact shadows; Eevee is an explicit draft option')
ap.add_argument('--denoise-quality', choices=['fast','balanced','high'], default='high', help='Denoiser quality for motion studies versus final masters')
ap.add_argument('--samples', type=int, help='Cycles samples; preview defaults to 16, videos to 32, stills to 64')
ap.add_argument('--scale', type=int, help='Resolution percent; preview defaults to 33')
a = ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
O = R / a.output
O.mkdir(parents=True, exist_ok=True)
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
key=area('Single reveal softbox',(0,0,.4),18,.08)
cd=bpy.data.cameras.new('Camera');cam=bpy.data.objects.new('Camera',cd);s.collection.objects.link(cam);s.camera=cam
cd.clip_start=.001;cd.clip_end=20;cd.type='ORTHO'
# The web exporter still uses the saved environment texture. Campaign renders
# have exactly one light: no world illumination/reflections, floor or haze.
if a.mode != 'web':
    world.node_tree.nodes.clear()
    black=world.node_tree.nodes.new('ShaderNodeBackground')
    black.inputs['Color'].default_value=(0,0,0,1)
    black.inputs['Strength'].default_value=0
    output=world.node_tree.nodes.new('ShaderNodeOutputWorld')
    world.node_tree.links.new(black.outputs[0],output.inputs['Surface'])
    for material in bpy.data.materials:
        if not material.use_nodes:continue
        for node in material.node_tree.nodes:
            if node.type=='BSDF_PRINCIPLED' and 'Emission Strength' in node.inputs:node.inputs['Emission Strength'].default_value=0
            if node.type=='EMISSION':node.inputs['Strength'].default_value=0
    s.render.film_transparent=False
    s.render.use_compositing=False
s.render.resolution_x=1920;s.render.resolution_y=1080;s.render.resolution_percentage=a.scale or (33 if a.mode=='preview' else 100);s.render.fps=24
s.view_settings.view_transform='AgX';s.view_settings.exposure=-.35
s.render.threads_mode='FIXED';s.render.threads=4
s.render.engine='CYCLES';s.cycles.samples=a.samples or (16 if a.mode=='preview' else 32 if a.mode=='videos' else 64);s.cycles.use_denoising=True;s.cycles.max_bounces=6;s.render.use_persistent_data=True
pref=bpy.context.preferences.addons['cycles'].preferences;pref.compute_device_type='METAL';pref.get_devices()
for d in pref.devices:d.use=d.type=='METAL'
s.cycles.device='GPU' if any(d.type=='METAL' for d in pref.devices) else 'CPU'
s.cycles.denoising_use_gpu=s.cycles.device=='GPU'
s.cycles.denoising_quality=a.denoise_quality.upper()
s.cycles.denoising_prefilter='FAST' if a.denoise_quality=='fast' else 'ACCURATE'
def show(sku):
    for prod,obs in groups.items():
        for o in obs:o.hide_render=sku!='family' and prod!=sku
def reset():
    for o in list(pivots.values())+[cam,key]:o.animation_data_clear()
    for p in pivots.values():p.location=(0,0,0);p.rotation_euler=(0,0,0)
    key.data.animation_data_clear();cd.animation_data_clear()
def reveal_light(target,t,extent):
    target=Vector(target)
    view=(cam.location-target).normalized()
    up=cam.rotation_euler.to_quaternion()@Vector((0,1,0))
    right=cam.rotation_euler.to_quaternion()@Vector((1,0,0))
    # A continuous overhead arc from the far side to the camera side. Brightness
    # comes from the real incidence angle, never an ambient fade or exposure key.
    angle=math.radians(178-158*(t*t*(3-2*t)))
    direction=(view*math.cos(angle)+up*math.sin(angle)+right*(-.18+.30*t)).normalized()
    key.location=target+direction*extent*2.8
    key.data.size=extent*.48;key.data.size_y=extent*.8
    key.data.energy=3*(extent/.1)**2
    aim(key,target)

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
    details=json.loads((R/'hardware/mechanical/advertising/board-details.json').read_text())['products']
    # Compact illustrative component bodies at the saved electrical placements.
    # No invented copper; exact connector CAD remains in the exterior model.
    for sku,detail in details.items():
        for c in detail['components']:
            w,h,t=c['size'];x,y,z=c['position'];angle=math.radians(c['rotation'])
            vertices=[]
            for zz in [0,t]:
                for xx,yy in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)]:
                    vertices.append(((x+xx*math.cos(angle)-yy*math.sin(angle))*.001,(y+xx*math.sin(angle)+yy*math.cos(angle))*.001,(z+zz)*.001))
            mesh=bpy.data.meshes.new('display-'+c['ref'])
            mesh.from_pydata(vertices,[],[(3,2,1,0),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);mesh.update()
            ob=bpy.data.objects.new(sku+'/display-'+c['ref'],mesh);s.collection.objects.link(ob)
            ob.parent=pivots[sku];ob.location=-centers[sku];ob['source_name']='display-'+c['ref'];ob['source_material']=c['material'];groups[sku].append(ob)
    def assembly(name):
        if name in ['lid','logo-white-inlay'] or name.startswith('lightpipe'):return 'lid'
        if name.startswith('case-screw'):return 'screws'
        if name in ['base','seam-sealant']:return 'base'
        if name.startswith('network-'):return 'network'
        if name.startswith(('button-','flexure-')):return 'buttons'
        return 'board'
    def explosion(sku,group):
        h=float(sizes[sku].y)
        factors={'lid':[0,1.2 if sku=='max' else .85,.35], 'screws':[0,1.2 if sku=='max' else .85,.5], 'base':[0,-.75,-.3], 'network':[0,.55,.2], 'buttons':[0,-.12,.08], 'board':[0,0,0]}
        return [round(x*h,6) for x in factors[group]]
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
            interior=(name=='pcb' or name=='Pi-port-27' or name.startswith(('display-','flexure-','button-frame','power-pcb-','power-service-tongue','lv-pcb-','network-','busbar-','isolated-5V-')))
            if not (visible or interior):continue
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
            key=(ob['source_material'],assembly(name),interior and not visible)
            bundles[key].append(arr);bpy.data.meshes.remove(me)
        blob=bytearray();parts=[]
        for (mat,group,interior),arrays in bundles.items():
            vertices,index=np.unique(np.round(np.concatenate(arrays),6),axis=0,return_inverse=True)
            vertices=np.asarray(vertices,dtype='<f4');index=np.asarray(index,dtype='<u4')
            offset=len(blob);blob.extend(vertices.tobytes());idxoffset=len(blob);blob.extend(index.tobytes())
            parts.append(dict(material=mat,assembly=group,interior=interior,explode=explosion(sku,group),offset=offset,vertices=len(vertices),indexOffset=idxoffset,indices=len(index)))
        (dest/(sku+'.bin')).write_bytes(blob)
        buttons=[]
        for n,b in enumerate(details[sku]['buttons'],1):
            vs=[v for i in cad['items'] if i['product']==sku and i['name']==f'button-shuttle-{n}' for v in i['vertices']]
            lo=np.min(vs,axis=0);hi=np.max(vs,axis=0);point=(lo+hi)/2;point[1]=lo[1]
            buttons.append(dict(id=b['id'],label=b['label'],description=b['description'],position=list(Vector(point)*.001-centers[sku]),normal=[0,-1,0]))
        sensors=[dict(sensor,position=list(Vector(sensor['position'])*.001-centers[sku])) for sensor in details[sku]['sensors']]
        manifest=dict(product=sku,revision='max-service-r11',size=list(sizes[sku]),ports=port_anchors(sku),buttons=buttons,sensors=sensors,inspection_note=details[sku]['note'],parts=parts,bytes=len(blob))
        (dest/(sku+'.json')).write_text(json.dumps(manifest));report[sku]=manifest
    env=next(n.image for n in world.node_tree.nodes if n.type=='TEX_ENVIRONMENT')
    copy=env.copy();copy.scale(1024,512);s.render.image_settings.file_format='JPEG';copy.save_render(str(dest/'environment.jpg'),scene=s)
    (O/'review'/'web-models.json').write_text(json.dumps(report,indent=2))
    (O/'review'/'web-topology.json').write_text(json.dumps(topology,indent=2))
elif a.mode=='stills':
    for sku in groups:
        if a.shot and a.shot!=sku:continue
        show(sku);reset();w=sizes[sku].x;h=sizes[sku].y
        for angle,loc in [('hero',(-1,-1.35,1.05)),('ports',(1.2,-1.4,.60)),('reverse',(1,1.3,.9)),('top',(0,-.001,2))]:
            if sku=='max' and angle=='ports':loc=(-1.5,-.45,.55)
            cam.location=Vector(loc)*w;aim(cam,(0,0,0));cd.ortho_scale=max(w*1.32,h*1.78*1.22)
            reveal_light((0,0,0),.85,max(w,h))
            still(O/'stills'/f'{sku}-{angle}.png')
    show('family');reset()
    for sku,pos in [('mini',(-.075,-.08)),('splanc',(.065,-.08)),('max',(0,.08))]:pivots[sku].location=(*pos,sizes[sku].z/2)
    cam.location=(.05,-.65,.6);aim(cam,(0,.015,.01));cd.ortho_scale=.57
    reveal_light((0,.015,.01),.85,.32)
    still(O/'stills'/'family.png')
    bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(O/'blender'/'family-studio.blend'),compress=True)
else:
    # Path-traced motion preserves the narrow connector recess occlusion.
    # Eevee is available only when explicitly requested for a geometry draft.
    s.render.engine='CYCLES' if a.engine=='cycles' else 'BLENDER_EEVEE_NEXT';s.eevee.taa_render_samples=16 if a.mode=='preview' else 48
    shots=[(k+'-orbit',k,96) for k in groups]+[('mini-macro-roll','mini',288),('family-pullback','family',120)]
    def ease(t):return t*t*(3-2*t)
    def record(o):
        o.keyframe_insert('location',frame=f);o.keyframe_insert('rotation_euler',frame=f)
    for name,sku,frames in shots:
        if a.shot and a.shot!=name:continue
        reset();show(sku);s.frame_start=1;s.frame_end=frames
        for f in range(1,frames+1):
            t=(f-1)/(frames-1)
            if name.endswith('orbit'):
                w=sizes[sku].x;h=sizes[sku].y;theta=math.radians(-145+110*ease(t))
                cam.location=(math.cos(theta)*w*1.9,math.sin(theta)*w*1.9,w*(.9+.15*math.sin(t*math.pi)))
                aim(cam,(0,0,0));cd.ortho_scale=max(w*1.42,h*1.78*1.3)
                reveal_light((0,0,0),t,max(w,h));record(key)
            elif name=='mini-macro-roll':
                # Slow stage-separation drift: only 20 degrees of attitude change
                # over twelve seconds. A small drift keeps it in frame for the reveal.
                p=pivots['mini'];q=Quaternion((0,0,1),math.radians(60))@Quaternion((0,1,0),math.radians(35))@Quaternion((1,0,0),math.radians(65-20*ease(t)))
                p.rotation_euler=q.to_euler();p.location=(.036*(t-.5),.0135*(t-.5),0);record(p)
                cam.location=(0,0,.2);aim(cam,(0,0,0));cd.ortho_scale=.12
                reveal_light(p.location,min(1,t/.9),max(sizes['mini'].x,sizes['mini'].y));record(key)
            else:
                u=ease(min(1,max(0,(t-.12)/.60)))
                for prod,final,sign in [('mini',(-.075,-.08),0),('splanc',(.065,-.08),1),('max',(0,.08),-1)]:
                    p=pivots[prod];p.location=(final[0]+sign*.60*(1-u),final[1],sizes[prod].z/2);p.rotation_euler=(0,0,math.radians(sign*26*(1-u)));record(p)
                target=Vector((-.075,-.08,.012)).lerp(Vector((0,.01,.014)),u)
                cam.location=target+Vector((0,-.65,.6));aim(cam,target);cd.ortho_scale=.052+(.57-.052)*u
                reveal_light((0,.01,.014),t,.32);record(key)
            record(cam);cd.keyframe_insert('ortho_scale',frame=f)
        for o in list(pivots.values())+[cam,key,cd,key.data]:
            if o.animation_data and o.animation_data.action:
                for fc in o.animation_data.action.fcurves:
                    for kp in fc.keyframe_points:kp.interpolation='LINEAR'
        lighting=[]
        for f in [1,round(frames*.25),round(frames*.5),round(frames*.75),frames]:
            s.frame_set(f)
            lighting.append(dict(frame=f,camera=list(cam.location),source=list(key.location),watts=key.data.energy))
            still(O/'review'/f'{name}-{f:03}.png')
        (O/'review'/f'{name}-lighting.json').write_text(json.dumps(dict(shot=name,denoise_quality=a.denoise_quality,engine=s.render.engine,samples=s.cycles.samples if s.render.engine=='CYCLES' else s.eevee.taa_render_samples,fps=s.render.fps,lights=[o.name for o in s.objects if o.type=='LIGHT'],world_strength=0,emission_enabled=False,floor=False,haze=False,frames=lighting),indent=2))
        if a.mode=='preview':continue
        bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(O/'blender'/f'{name}.blend'),compress=True)
        s.render.image_settings.file_format='FFMPEG';s.render.ffmpeg.format='MPEG4';s.render.ffmpeg.codec='H264';s.render.ffmpeg.constant_rate_factor='HIGH';s.render.ffmpeg.ffmpeg_preset='GOOD';s.render.filepath=str(O/'video'/f'{name}.mp4')
        rendered=bpy.ops.render.render(animation=True)
        if 'FINISHED' not in rendered:raise RuntimeError(f'Animation render did not finish: {rendered}')
        print('VIDEO COMPLETE',name,flush=True)
