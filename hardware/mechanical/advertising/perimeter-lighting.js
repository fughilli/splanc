import * as T from './vendor/three.module.js';

// One full-screen pass approximates inward RGB spill on opaque product pixels.
// It deliberately adds no shadow maps or per-triangle dynamic point lights.
export class PerimeterLighting {
 constructor(renderer){
  this.renderer=renderer;this.target=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthBuffer:true,samples:2});
  renderer.info.autoReset=false;
  this.scene=new T.Scene();this.camera=new T.OrthographicCamera(-1,1,1,-1,0,1);
  this.uniforms={image:{value:this.target.texture},viewport:{value:new T.Vector2()},lights:{value:Array.from({length:9},()=>new T.Vector4())},colors:{value:Array.from({length:9},()=>new T.Vector3())}};
  const material=new T.ShaderMaterial({uniforms:this.uniforms,transparent:true,depthTest:false,depthWrite:false,
   vertexShader:'varying vec2 uvOut; void main(){uvOut=uv;gl_Position=vec4(position.xy,0.,1.);}',
   fragmentShader:`uniform sampler2D image; uniform vec2 viewport; uniform vec4 lights[9]; uniform vec3 colors[9]; varying vec2 uvOut;
    void main(){
     vec4 surface=texture2D(image,uvOut);vec2 p=vec2(uvOut.x,1.-uvOut.y)*viewport;
     vec3 spill=vec3(0.);float reach=max(viewport.x,viewport.y)*.72;
     for(int i=0;i<9;i++){
      vec2 delta=p-lights[i].xy;float d=length(delta);
      float cone=pow(max(0.,dot(delta/max(d,1.),lights[i].zw)),2.);
      float falloff=exp(-3.*d/reach);
      spill+=colors[i]*cone*falloff;
     }
     float mask=smoothstep(.97,1.,surface.a);
     surface.rgb+=spill*(.004+surface.rgb*.55)*mask;
     gl_FragColor=surface;
     #include <tonemapping_fragment>
     #include <colorspace_fragment>
    }`});
  this.scene.add(new T.Mesh(new T.PlaneGeometry(2,2),material));
 }
 resize(w,h){const dpr=this.renderer.getPixelRatio();this.target.setSize(Math.round(w*dpr),Math.round(h*dpr));this.uniforms.viewport.value.set(w,h);}
 begin(){this.renderer.info.reset();this.renderer.setRenderTarget(this.target);}
 finish(lights){
  for(let i=0;i<9;i++){
   const l=lights[i];this.uniforms.lights.value[i].set(l.x,l.y,l.nx,l.ny);
   const c=new T.Color().setHSL(l.hue/360,1,.5);this.uniforms.colors.value[i].set(c.r,c.g,c.b).multiplyScalar(l.brightness*1.2);
  }
  this.renderer.setRenderTarget(null);this.renderer.render(this.scene,this.camera);
 }
}
