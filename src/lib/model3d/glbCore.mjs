/** Bounded, dependency-free GLB preparation shared by native, Node and browser. */
export const GLB_LIMITS = Object.freeze({maxBytes:200*1024*1024,warnBytes:50*1024*1024,maxTriangles:5e6,warnTriangles:2e6,maxItems:100000,maxAccessorValues:60000000,maxInspectedValues:200000000});
export class GlbError extends Error { constructor(code,message){super(message);this.name='GlbError';this.code=code;} }
const fail=(code,message)=>{throw new GlbError(code,message);};
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const finiteArray=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
const array=(v,name)=>{if(v==null)return [];if(!Array.isArray(v)||v.length>GLB_LIMITS.maxItems)fail('structure',`Invalid or excessive ${name}`);return v;};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hint='Use fp.mesh3d(..., max_faces=…) to reduce the mesh.';
export function cyrb53(value,seed=0){let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;for(let i=0;i<value.length;i++){const c=typeof value==='string'?value.charCodeAt(i):value[i];h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return 4294967296*(2097151&h2)+(h1>>>0);}
export const hex14=hash=>hash.toString(16).padStart(14,'0');
export function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;}
const asBytes=input=>input instanceof Uint8Array?input:input instanceof ArrayBuffer?new Uint8Array(input):fail('input','Expected binary GLB bytes. Export as binary .glb, e.g. fp.save(scene, "model").');
export function parseGlb(input){
 const u8=asBytes(input);if(u8.byteLength>GLB_LIMITS.maxBytes)fail('limit',`GLB is ${u8.byteLength} bytes; maximum is ${GLB_LIMITS.maxBytes}. ${hint}`);
 if(u8.length<12)fail('header','Truncated GLB header. Export as binary .glb, e.g. fp.save(scene, "model").');
 const view=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
 if(view.getUint32(0,true)!==0x46546c67)fail('format','Expected binary .glb, not .gltf JSON. Export as binary .glb, e.g. fp.save(scene, "model").');
 if(view.getUint32(4,true)!==2)fail('version','Only GLB version 2 is supported.');
 if(view.getUint32(8,true)!==u8.length)fail('length','GLB declared length does not match file (truncated or trailing bytes).');
 let offset=12,json,bin=new Uint8Array(0),chunks=0;
 while(offset<u8.length){
  if(u8.length-offset<8)fail('chunk','Truncated GLB chunk header.');
  const len=view.getUint32(offset,true),kind=view.getUint32(offset+4,true);offset+=8;
  if(len%4||len>u8.length-offset)fail('chunk','GLB chunk has an invalid length or alignment.');
  const bytes=u8.subarray(offset,offset+len);offset+=len;
  if(chunks===0&&kind!==0x4e4f534a)fail('chunk','The first GLB chunk must be JSON.');
  if(kind===0x4e4f534a){if(json!==undefined)fail('chunk','Duplicate GLB JSON chunk.');try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('json','Invalid GLB JSON chunk.');}}
  else if(kind===0x004e4942){if(chunks!==1)fail('chunk','BIN must follow JSON and appear once.');bin=bytes;}
  // glTF 2.0: clients MUST ignore chunks of unknown type after the first two;
  // prepare re-encodes only JSON and BIN, so ignored chunks are also stripped.
  chunks++;
 }
 if(!object(json)||json.asset?.version!=='2.0')fail('json','GLB must contain a glTF 2.0 object.');
 return {json,bin};
}
const COMPONENT={5120:[1,'getInt8',127],5121:[1,'getUint8',255],5122:[2,'getInt16',32767],5123:[2,'getUint16',65535],5125:[4,'getUint32',4294967295],5126:[4,'getFloat32',1]};
const WIDTH={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
function makeReader(json,bin){
 const buffers=array(json.buffers,'buffers');if(buffers.length!==1||!object(buffers[0])||buffers[0].uri!=null)fail('buffers','GLB must use one embedded buffer, without external or data-URI buffers.');
 const length=buffers[0].byteLength;if(!integer(length)||length>bin.length||bin.length-length>3)fail('buffer','Invalid embedded buffer length.');
 const views=array(json.bufferViews,'bufferViews'),accessors=array(json.accessors,'accessors');
 for(const v of views){if(!object(v)||v.buffer!==0||!integer(v.byteOffset??0)||!integer(v.byteLength)||v.byteLength>length-(v.byteOffset??0))fail('bufferView','Buffer view exceeds the embedded buffer.');if(v.byteStride!=null&&(!integer(v.byteStride,4)||v.byteStride>252||v.byteStride%4))fail('stride','Invalid buffer view byteStride.');}
 const dv=new DataView(bin.buffer,bin.byteOffset,bin.byteLength),cache=new Map();
 function bufferSlice(index,offset,bytes,stride,count){const v=views[index];if(!v||!integer(offset)||offset+bytes+(count-1)*stride>v.byteLength)fail('accessor','Accessor exceeds its buffer view.');return (v.byteOffset??0)+offset;}
 function read(index){
  if(!integer(index)||!accessors[index])fail('accessor',`Missing accessor ${index}.`);if(cache.has(index))return cache.get(index);
  const a=accessors[index],component=COMPONENT[a.componentType],width=WIDTH[a.type];
  if(!component||!width||!integer(a.count,1)||a.count*width>GLB_LIMITS.maxAccessorValues)fail('accessor','Invalid or excessive accessor shape.');
  const [size,get,divisor]=component;
  // Matrix columns are individually padded to four bytes by glTF.
  const dim=a.type.startsWith('MAT')?Number(a.type.slice(3)):0,colStride=dim?Math.ceil(dim*size/4)*4:0;
  const bytes=dim?dim*colStride:width*size;
  const v=a.bufferView==null?null:views[a.bufferView],stride=v?.byteStride??bytes,off=a.byteOffset??0;
  if(!integer(off)||off%size||stride<bytes||stride%size||(a.bufferView!=null&&!v))fail('accessor','Invalid accessor offset, view or stride.');
  const base=v?bufferSlice(a.bufferView,off,bytes,stride,a.count):0;
  if(base%size)fail('alignment','Accessor data is not component-aligned.');
  // glTF 2.0: an accessor without bufferView is zero-initialized (get() reads 0).
  const componentOffset=c=>dim?Math.floor(c/dim)*colStride+(c%dim)*size:c*size;
  const normalize=value=>a.normalized&&a.componentType!==5126?Math.max(a.componentType===5120||a.componentType===5122?-1:0,value/divisor):value;
  let sparse;
  if(a.sparse){const s=a.sparse,ic=COMPONENT[s.indices?.componentType];if(!integer(s.count,1)||s.count>a.count||!ic||![5121,5123,5125].includes(s.indices.componentType))fail('sparse','Invalid sparse accessor.');
   if(views[s.indices.bufferView]?.byteStride||views[s.values?.bufferView]?.byteStride)fail('sparse','Sparse buffer views cannot have byteStride.');
   const ib=bufferSlice(s.indices.bufferView,s.indices.byteOffset??0,ic[0],ic[0],s.count),vb=bufferSlice(s.values?.bufferView,s.values?.byteOffset??0,bytes,bytes,s.count);
   if(ib%ic[0]||vb%size)fail('sparse','Misaligned sparse accessor.');
   const indices=new Uint32Array(s.count);let prev=-1;for(let i=0;i<s.count;i++){const k=dv[ic[1]](ib+i*ic[0],true);if(k<=prev||k>=a.count)fail('sparse','Sparse indices must increase and lie inside accessor.');indices[i]=k;prev=k;}sparse={indices,base:vb,bytes};
  }
  const result={count:a.count,width,componentType:a.componentType,normalized:!!a.normalized,min:a.min,max:a.max,
   get:(i,c=0)=>{let sp=-1;if(sparse){let lo=0,hi=sparse.indices.length-1;while(lo<=hi){const mid=(lo+hi)>>>1,k=sparse.indices[mid];if(k===i){sp=sparse.base+mid*sparse.bytes;break;}if(k<i)lo=mid+1;else hi=mid-1;}}return normalize(sp>=0?dv[get](sp+componentOffset(c),true):v?dv[get](base+i*stride+componentOffset(c),true):0);}};
  for(const which of ['min','max'])if(a[which]!=null&&!finiteArray(a[which],width))fail('bounds',`Invalid accessor ${which}.`);
  if(a.min&&a.max&&a.min.some((n,c)=>n>a.max[c]))fail('bounds','Accessor bounds are reversed.');
  cache.set(index,result);return result;
 }
 for(let i=0;i<accessors.length;i++)read(i);
 return read;
}
const ID=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function multiply(a,b){const out=Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)out[c*4+r]+=a[k*4+r]*b[c*4+k];return out;}
export function transformPoint(m,p){return [0,1,2].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);}
function nodeMatrix(node){
 if(node.matrix!=null){if(!finiteArray(node.matrix,16)||node.matrix[3]!==0||node.matrix[7]!==0||node.matrix[11]!==0||node.matrix[15]!==1)fail('transform','Invalid affine node matrix.');return node.matrix;}
 const t=node.translation??[0,0,0],s=node.scale??[1,1,1],q=node.rotation??[0,0,0,1];if(!finiteArray(t,3)||!finiteArray(s,3)||!finiteArray(q,4))fail('transform','Non-finite or malformed node transform.');
 const len=Math.hypot(...q);if(Math.abs(len-1)>1e-3)fail('transform','Node quaternion must have unit length.');const [x,y,z,w]=q;
 return [(1-2*y*y-2*z*z)*s[0],(2*x*y+2*z*w)*s[0],(2*x*z-2*y*w)*s[0],0,(2*x*y-2*z*w)*s[1],(1-2*x*x-2*z*z)*s[1],(2*y*z+2*x*w)*s[1],0,(2*x*z+2*y*w)*s[2],(2*y*z-2*x*w)*s[2],(1-2*x*x-2*y*y)*s[2],0,...t,1];
}
function accessorBounds(a,allowMissing=false){const min=Array(a.width).fill(Infinity),max=Array(a.width).fill(-Infinity);for(let i=0;i<a.count;i++)for(let c=0;c<a.width;c++){const v=a.get(i,c);if(!Number.isFinite(v)){if(allowMissing)continue;fail('nonfinite','Geometry contains NaN or infinity.');}min[c]=Math.min(min[c],v);max[c]=Math.max(max[c],v);}return {min,max};}
function topologyHash(index,count){let h1=0xdeadbeef,h2=0x41c6ce57;for(let i=0;i<count;i++){const v=index?index.get(i):i;for(let shift=0;shift<32;shift+=8){const b=(v>>>shift)&255;h1=Math.imul(h1^b,2654435761);h2=Math.imul(h2^b,1597334677);}}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return hex14(4294967296*(2097151&h2)+(h1>>>0));}
function extensionNames(json){const names=new Set([...(json.extensionsUsed??[]),...(json.extensionsRequired??[])]);const stack=[json];let seen=0;while(stack.length){const v=stack.pop();if(!object(v)&&!Array.isArray(v))continue;if(++seen>500000)fail('structure','GLB JSON is too complex.');if(object(v.extensions))for(const name of Object.keys(v.extensions))names.add(name);for(const [k,x]of Object.entries(v))if(k!=='extras'&&x&&typeof x==='object')stack.push(x);}return [...names].sort();}
const linearHex=rgb=>'#'+rgb.slice(0,3).map(x=>Math.round(255*(x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055))).map(x=>Math.max(0,Math.min(255,x)).toString(16).padStart(2,'0')).join('');
function inspectParsed(json,bin,byteLength){
 const warnings=[],extensions=extensionNames(json);
 for(const ext of extensions)if(ext==='KHR_draco_mesh_compression'||ext==='EXT_meshopt_compression'||ext==='KHR_meshopt_compression')fail('compression',`${ext} is unsupported. Re-export without compression, e.g. gltfpack -i in.glb -o out.glb without -c/-cc.`);
 for(const ext of array(json.extensionsRequired,'extensionsRequired'))if(!['KHR_mesh_quantization','KHR_lights_punctual'].includes(ext))fail('extension',`Required extension ${ext} is unsupported.`);
 const read=makeReader(json,bin),nodes=array(json.nodes,'nodes'),meshes=array(json.meshes,'meshes'),scenes=array(json.scenes,'scenes'),materials=array(json.materials,'materials');
 if(json.images?.length||json.textures?.length||materials.some(m=>JSON.stringify(m).includes('Texture')))warnings.push('textures are ignored');
 if(json.animations?.length)warnings.push('animations are ignored');if(json.cameras?.length||extensions.includes('KHR_lights_punctual'))warnings.push('cameras and lights are ignored');if(json.skins?.length||json.nodes?.some(n=>n?.skin!=null))warnings.push('skinning is ignored; stored mesh geometry is shown');
 const stateNames=new Map(),stateSet=new Set(),invalidStates=new Set();
 for(let mi=0;mi<meshes.length;mi++){
  const m=meshes[mi],ps=array(m.primitives,'primitives');if(!ps.length)fail('mesh','Mesh has no primitives.');
  const counts=ps.map(p=>array(p.targets,'morph targets').length);
  if(counts.some(c=>c!==counts[0])){invalidStates.add(mi);warnings.push(`mesh ${m.name??mi}: inconsistent morph-target counts; shape states ignored`);continue;}
  if(counts[0]){const supplied=m.extras?.targetNames;const names=Array.from({length:counts[0]},(_,i)=>typeof supplied?.[i]==='string'&&supplied[i]?supplied[i]:`state-${i}`);if(new Set(names).size!==names.length)fail('states','Duplicate shape-state names in a mesh.');stateNames.set(mi,names);}
 }
 let inspectedValues=0;const spend=n=>{inspectedValues+=n;if(inspectedValues>GLB_LIMITS.maxInspectedValues)fail('limit',`Geometry inspection exceeds ${GLB_LIMITS.maxInspectedValues} scalar values (including instances and states). ${hint}`);};
 let triangles=0,vertices=0,primitives=0,hasNormals=true,hasColors=false,hasValues=false;const usedMeshes=new Set(),parts=[],partNames=[],bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
 const seen=new Set(),namedNodes=new Map(),duplicateNames=new Set();let roots;
 if(scenes.length){const scene=json.scene??0;if(!integer(scene)||!scenes[scene])fail('scene','Default scene is missing.');roots=array(scenes[scene].nodes,'scene nodes');}
 else {const children=new Set(nodes.flatMap(n=>array(n.children,'node children')));roots=nodes.map((_,i)=>i).filter(i=>!children.has(i));}
 const stack=roots.map(i=>({i,m:ID,depth:0})).reverse();
 while(stack.length){const {i,m,depth}=stack.pop();if(!integer(i)||!nodes[i]||seen.has(i)||depth>1000)fail('hierarchy','Invalid, cyclic or multiply-parented node hierarchy.');seen.add(i);const node=nodes[i],world=multiply(m,nodeMatrix(node));if(world.some(v=>!Number.isFinite(v)))fail('transform','Node world transform overflowed.');
  for(const child of [...array(node.children,'node children')].reverse())stack.push({i:child,m:world,depth:depth+1});
  if(node.mesh==null)continue;const mesh=meshes[node.mesh];if(!integer(node.mesh)||!mesh)fail('mesh','Node refers to a missing mesh.');usedMeshes.add(node.mesh);for(const name of stateNames.get(node.mesh)??[])stateSet.add(name);
  for(let pi=0;pi<mesh.primitives.length;pi++){
   const p=mesh.primitives[pi],mode=p.mode??4;if(!integer(mode)||mode>6)fail('mode','Invalid primitive mode.');if(mode<4)fail('mode','3D points and lines are not supported; export triangle meshes.');
   const pos=read(p.attributes?.POSITION);if(pos.width!==3)fail('position','POSITION must be VEC3.');
   const n=pos.count;spend(n*3*(2+(p.targets?.length??0)*2));const index=p.indices==null?null:read(p.indices);if(index&&(index.width!==1||![5121,5123,5125].includes(index.componentType)||index.normalized))fail('indices','Invalid primitive index accessor.');
   const count=index?.count??n;spend(count);if(mode===4&&count%3)fail('indices','TRIANGLES index count must be divisible by three.');
   for(let k=0;index&&k<count;k++)if(index.get(k)>=n)fail('indices','Primitive index is outside POSITION.');
   triangles+=mode===4?count/3:mode===5||mode===6?Math.max(0,count-2):0;if(triangles>GLB_LIMITS.maxTriangles)fail('limit',`${triangles} triangles exceeds ${GLB_LIMITS.maxTriangles}. ${hint}`);
   vertices+=n;primitives++;
   for(const [key,value] of Object.entries(p.attributes??{})){const a=read(value);spend(a.count*a.width);if(a.count!==n)fail('attributes',`${key} vertex count differs from POSITION.`);if(key==='NORMAL'&&a.width!==3)fail('attributes','NORMAL must be VEC3.');if(key==='_VALUE'&&(a.width!==1||a.componentType!==5126))fail('attributes','_VALUE must be float32 SCALAR.');if(key==='_VALID'&&(a.width!==1||a.componentType!==5121))fail('attributes','_VALID must be uint8 SCALAR.');if(key!=='_VALUE')accessorBounds(a);else for(let vi=0;vi<a.count;vi++)if(!Number.isFinite(a.get(vi))&&!warnings.includes('legacy non-finite _VALUE treated as missing'))warnings.push('legacy non-finite _VALUE treated as missing');if(key==='_VALID')for(let vi=0;vi<a.count;vi++)if(a.get(vi)!==0&&a.get(vi)!==1)fail('attributes','_VALID must contain only 0 or 1.');}
   hasNormals&&=p.attributes.NORMAL!=null;hasColors||=p.attributes.COLOR_0!=null;hasValues||=p.attributes._VALUE!=null;
   const local=accessorBounds(pos),boxes=[local];
   if(!invalidStates.has(node.mesh))for(const target of p.targets??[]){if(target.POSITION==null)continue;const delta=read(target.POSITION);if(delta.width!==3||delta.count!==n)fail('states','Shape-state POSITION differs from base vertex shape.');accessorBounds(delta);const state={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};for(let vi=0;vi<n;vi++)for(let c=0;c<3;c++){const value=pos.get(vi,c)+delta.get(vi,c);if(!Number.isFinite(value))fail('states','Shape-state position overflowed.');state.min[c]=Math.min(state.min[c],value);state.max[c]=Math.max(state.max[c],value);}boxes.push(state);if(target.NORMAL!=null){const normal=read(target.NORMAL);if(normal.width!==3||normal.count!==n)fail('states','Shape-state NORMAL differs from base vertex shape.');accessorBounds(normal);}}
   for(const b of boxes)for(let mask=0;mask<8;mask++){const point=transformPoint(world,[0,1,2].map(c=>(mask>>c)&1?b.max[c]:b.min[c]));if(point.some(v=>!Number.isFinite(v)))fail('transform','Transformed geometry bounds overflowed.');point.forEach((v,c)=>{bounds.min[c]=Math.min(bounds.min[c],v);bounds.max[c]=Math.max(bounds.max[c],v);});}
   const name=typeof node.name==='string'?node.name:'';if(name){if(namedNodes.has(name)&&namedNodes.get(name)!==i)duplicateNames.add(name);namedNodes.set(name,i);}partNames.push(name||`node-${i}`);parts.push({node:name,mode,vertices:n,indicesHash:topologyHash(index,count)});
  }
 }
 if(!primitives)fail('empty','The default GLB scene contains no geometry.');
 // Node names are only stable match keys when unique across nodes. Ambiguous names
 // fall back to primitive order; multiple primitives of one node retain its name.
 for(const part of parts)if(duplicateNames.has(part.node))part.node='';
 if(byteLength>GLB_LIMITS.warnBytes)warnings.push(`${byteLength} bytes exceeds the ${GLB_LIMITS.warnBytes}-byte warning threshold. ${hint}`);
 if(triangles>GLB_LIMITS.warnTriangles)warnings.push(`${triangles} triangles exceeds the ${GLB_LIMITS.warnTriangles}-triangle warning threshold. ${hint}`);
 return {info:{triangles,vertices,primitives,meshes:usedMeshes.size,bounds,hasNormals,hasColors,hasValues,
  materialColors:materials.map(m=>linearHex(m.pbrMetallicRoughness?.baseColorFactor??[1,1,1,1])),partNames,warnings,extensions,
  topology:{key:hex14(cyrb53(canonical(parts))),parts},states:[...stateSet]},invalidStates};
}
function inspectGlbUnsafe(input){const bytes=asBytes(input),{json,bin}=parseGlb(bytes);return inspectParsed(json,bin,bytes.length).info;}
function encodeGlb(json,bin){const j=new TextEncoder().encode(canonical(json)),jl=Math.ceil(j.length/4)*4,bl=Math.ceil(bin.length/4)*4;const bytes=new Uint8Array(12+8+jl+8+bl),dv=new DataView(bytes.buffer);dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,bytes.length,true);dv.setUint32(12,jl,true);dv.setUint32(16,0x4e4f534a,true);bytes.fill(32,20,20+jl);bytes.set(j,20);dv.setUint32(20+jl,bl,true);dv.setUint32(24+jl,0x004e4942,true);bytes.set(bin,28+jl);return bytes;}
function prepareGlbUnsafe(input,_opts={}){
 const source=asBytes(input),{json,bin}=parseGlb(source),{info,invalidStates}=inspectParsed(json,bin,source.length);
 delete json.images;delete json.textures;delete json.samplers;delete json.animations;delete json.cameras;delete json.skins;
 for(const node of json.nodes??[]){delete node.camera;delete node.skin;}
 for(const mi of invalidStates){const m=json.meshes[mi];for(const p of m.primitives)delete p.targets;delete m.weights;if(m.extras)delete m.extras.targetNames;}
 for(const m of json.materials??[]){const p=m.pbrMetallicRoughness;if(p){delete p.baseColorTexture;delete p.metallicRoughnessTexture;}delete m.normalTexture;delete m.occlusionTexture;delete m.emissiveTexture;}
 const stack=[json];while(stack.length){const v=stack.pop();if(!v||typeof v!=='object')continue;if(v.extensions){delete v.extensions;}
 for(const [k,x]of Object.entries(v))if(k!=='extras'&&x&&typeof x==='object')stack.push(x);}
 for(const key of ['extensionsUsed','extensionsRequired']){const kept=(json[key]??[]).filter(x=>x==='KHR_mesh_quantization');if(kept.length)json[key]=kept;else delete json[key];}
 const bytes=encodeGlb(json,bin);return {bytes,info};
}
/** Deterministic fixture writer. Array input is packed little endian, never welded/reordered. */
export function writeGlb(spec){
 const json={asset:{version:'2.0',generator:'Flux model3d fixtures'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[],buffers:[{byteLength:0}],bufferViews:[],accessors:[]};const chunks=[];let offset=0;
 function put(values,width,type=5126,normalized=false,vertex=false){const [size,set]=({5121:[1,'setUint8'],5123:[2,'setUint16'],5125:[4,'setUint32'],5126:[4,'setFloat32']})[type];const flat=ArrayBuffer.isView(values)?values:values.flat?.(2)??values;const stride=vertex?Math.ceil(width*size/4)*4:width*size,byteLength=flat.length/width*stride;const bytes=new Uint8Array(Math.ceil(byteLength/4)*4),dv=new DataView(bytes.buffer);for(let i=0;i<flat.length;i++)dv[set](Math.floor(i/width)*stride+(i%width)*size,flat[i],true);const bv=json.bufferViews.push({buffer:0,byteOffset:offset,byteLength,...(stride!==width*size?{byteStride:stride}:{})})-1;chunks.push(bytes);offset+=bytes.length;const a={bufferView:bv,componentType:type,count:flat.length/width,type:width===1?'SCALAR':`VEC${width}`};if(normalized)a.normalized=true;if(type===5126&&width===3){a.min=Array(width).fill(Infinity);a.max=Array(width).fill(-Infinity);for(let i=0;i<flat.length;i++){a.min[i%width]=Math.min(a.min[i%width],flat[i]);a.max[i%width]=Math.max(a.max[i%width],flat[i]);}}return json.accessors.push(a)-1;}
 for(const p of spec.parts){const positions=ArrayBuffer.isView(p.positions)?p.positions:p.positions.flat(2),n=positions.length/3;
  const attributes={POSITION:put(positions,3)};if(p.normals)attributes.NORMAL=put(p.normals,3);if(p.colors)attributes.COLOR_0=put(p.colors,p.colors.length===n*4?4:3,5126);if(p.values)attributes._VALUE=put(p.values,1);if(p.valid)attributes._VALID=put(p.valid,1,5121,false,true);
  const primitive={attributes,mode:p.mode??4,material:json.materials.length};if(p.indices){const idx=ArrayBuffer.isView(p.indices)?p.indices:p.indices.flat(2);let max=0;for(const v of idx)max=Math.max(max,v);primitive.indices=put(idx,1,p.indexType??(max<65536?5123:5125));}
  const mesh={primitives:[primitive]};if(p.states){const names=Object.keys(p.states);primitive.targets=names.map(name=>{const value=p.states[name],delta=value.positions??value;const target={POSITION:put(delta,3)};if(value.normals)target.NORMAL=put(value.normals,3);return target;});mesh.extras={targetNames:names};mesh.weights=names.map(name=>p.weights?.[name]??0);}
  const color=p.color??[.0578,.2346,.5149,1];json.materials.push({pbrMetallicRoughness:{baseColorFactor:color,metallicFactor:0,roughnessFactor:.6},doubleSided:true});
  json.scenes[0].nodes.push(json.nodes.length);json.nodes.push({...(p.name?{name:p.name}:{}),mesh:json.meshes.length,...(p.matrix?{matrix:p.matrix}:{})});json.meshes.push(mesh);
 }
 json.buffers[0].byteLength=offset;const bin=new Uint8Array(offset);let at=0;for(const c of chunks){bin.set(c,at);at+=c.length;}if(spec.modify)spec.modify(json,bin);return encodeGlb(json,bin);
}

function safeGlb(fn){try{return fn();}catch(error){if(error instanceof GlbError)throw error;throw new GlbError('structure','Malformed GLB structure: '+(error instanceof Error?error.message:String(error)));}}
export const inspectGlb=input=>safeGlb(()=>inspectGlbUnsafe(input));
export const prepareGlb=(input,opts)=>safeGlb(()=>prepareGlbUnsafe(input,opts));
