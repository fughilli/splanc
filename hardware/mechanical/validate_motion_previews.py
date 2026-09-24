"""Decode actual MP4s with Blender and export sample frames for visual QA."""
import bpy,json,sys,argparse
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--root',default='output/motion-studies-r1');args=ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
root=Path.cwd()/args.root;specs=json.loads((root/'catalog.json').read_text());report={}
scene=bpy.context.scene;scene.render.use_sequencer=True;scene.render.resolution_x=640;scene.render.resolution_y=360;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='Standard';scene.view_settings.look='None';scene.view_settings.exposure=0
for spec in specs:
 name=spec['name'];p=root/name/(name+'.mp4');clip=bpy.data.movieclips.load(str(p));assert clip.frame_duration==spec['frames'],(name,clip.frame_duration);assert tuple(clip.size)==tuple(spec.get('resolution',[640,360])),(name,tuple(clip.size))
 scene.sequence_editor_clear();ed=scene.sequence_editor_create();strips=ed.strips if hasattr(ed,'strips') else ed.sequences
 strip=strips.new_movie(name,str(p),channel=1,frame_start=1);scene.render.fps=24
 strip.transform.scale_x=scene.render.resolution_x/clip.size[0];strip.transform.scale_y=scene.render.resolution_y/clip.size[1]
 for f in (max(1,round(spec['frames']*.08)),round(spec['frames']*.35),round(spec['frames']*.5),round(spec['frames']*.65),spec['frames']):
  scene.frame_set(f);scene.render.filepath=str(root/name/f'decoded-{f:03}.png');bpy.ops.render.render(write_still=True)
 report[name]={'frames':clip.frame_duration,'dimensions':list(clip.size),'bytes':p.stat().st_size,'decoded_samples':5}
(root/'video-validation.json').write_text(json.dumps(report,indent=2));print(report,flush=True)
