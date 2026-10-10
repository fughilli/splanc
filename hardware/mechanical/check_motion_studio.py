import bpy,json
from pathlib import Path
p=Path.cwd()/'output/blender-motion-studio-r4';bpy.ops.wm.open_mainfile(filepath=str(p/'splanc-motion-studio.blend'))
report={}
for name in ['01 · Entry B','02 · Macro roll']:
 s=bpy.data.scenes[name];assert s.camera and s.camera.animation_data and s.camera.data.animation_data
 assert any(o.name.startswith('CAMERA TARGET') for o in s.objects)
 assert any(o.name.startswith('PRODUCT') and o.animation_data for o in s.objects)
 report[name]={'frames':s.frame_end,'camera':s.camera.name,'camera_keys':sum(len(f.keyframe_points) for f in s.camera.animation_data.action.fcurves),'objects':len(s.objects)}
missing=[i.name for i in bpy.data.images if i.source=='FILE' and not i.packed_file and i.users]
assert not missing,missing
report['packed_images']=len([i for i in bpy.data.images if i.packed_file]);report['bytes']=(p/'splanc-motion-studio.blend').stat().st_size
(p/'project-validation.json').write_text(json.dumps(report,indent=2));print(report)
