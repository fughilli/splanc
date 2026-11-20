const fs=require("fs");const D=require("./dist2/cv/diffuseDetect.js");
const f=process.argv[2];const {rgb,w,h}=D.boxReduceRgb8(fs.readFileSync(f),720,1280,2);
const P=D.DEFAULT_ADAPTIVE_DIFFUSE;const n=w*h;const dog=[];const pl=new Float32Array(n);
for(let c=0;c<3;c++){for(let i=0;i<n;i++)pl[i]=rgb[i*3+c];const s=D.box3(pl,w,h,P.spotBoxRadius),b=D.box3(pl,w,h,P.bgBoxRadius);for(let i=0;i<n;i++)s[i]-=b[i];dog.push(s);}
const resp=new Float32Array(n);for(let i=0;i<n;i++)resp[i]=Math.max(dog[0][i],dog[1][i],dog[2][i]);
fs.writeFileSync(process.argv[3],Buffer.from(resp.buffer));console.log(w,h);
