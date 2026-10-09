// Metadata and binary buffers must come from the same immutable model revision.
let catalog;
async function json(url,options){
 const response=await fetch(url,options);if(!response.ok)throw Error(`Model metadata: HTTP ${response.status}`);return response.json();
}
export function validateModel(meta,buffer){
 if(meta.bytes!==buffer.byteLength)throw Error(`Model size mismatch for ${meta.product}; reload to retry.`);
 for(const p of meta.parts){
  for(const key of ['offset','vertices','indexOffset','indices'])if(!Number.isSafeInteger(p[key])||p[key]<0)throw Error('Invalid model offsets');
  if(p.offset%4||p.indexOffset%4||p.indices%3||p.offset+p.vertices*24>buffer.byteLength||p.indexOffset+p.indices*4>buffer.byteLength)throw Error('Model buffer bounds mismatch');
  const vertices=new Float32Array(buffer,p.offset,p.vertices*6),indices=new Uint32Array(buffer,p.indexOffset,p.indices);
  for(const index of indices)if(index>=p.vertices)throw Error('Model index outside vertex buffer');
  for(const v of vertices)if(!Number.isFinite(v))throw Error('Non-finite model geometry');
 }
 if(!meta.parts.some(p=>p.material==='shell_lid')||!meta.parts.some(p=>p.material==='shell_base'))throw Error('Enclosure geometry missing from model');
}
export async function loadModelData(sku){
 catalog??=json('models/index.json',{cache:'no-store'});
 const index=await catalog,meta=await json(`models/${index[sku]}`),compressed=typeof DecompressionStream==='function';
 const response=await fetch(`models/${meta.mesh_file}${compressed?'.gz':''}`);
 if(!response.ok)throw Error(`Model mesh: HTTP ${response.status}`);
 const buffer=compressed?await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():await response.arrayBuffer();
 validateModel(meta,buffer);return {meta,buffer};
}
