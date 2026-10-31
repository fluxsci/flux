// resvg 0.34 uses bicubic for SVG auto and ignores CSS pixelated/crisp-edges.
// Chromium 150 uses bilinear/mipmaps and nearest respectively. Prepare only
// embedded raster bytes in the supervised child; authored SVG is untouched.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { pngInfo, probeImageSize } from './plotThumbRules.mjs';
const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js');
const ID = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const nums = value => (value.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
function transform(value) {
  let matrix = ID;
  for (const match of value.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const n = nums(match[2]); let next;
    switch (match[1]) {
      case 'matrix': if (n.length === 6) next = n; break;
      case 'translate': next = [1,0,0,1,n[0],n[1] ?? 0]; break;
      case 'scale': next = [n[0],0,0,n[1] ?? n[0],0,0]; break;
      case 'rotate': { const a=n[0]*Math.PI/180, c=Math.cos(a), s=Math.sin(a), x=n[1]??0, y=n[2]??0; next=[c,s,-s,c,x-c*x+s*y,y-s*x-c*y]; break; }
      case 'skewX': next=[1,0,Math.tan(n[0]*Math.PI/180),1,0,0]; break;
      case 'skewY': next=[1,Math.tan(n[0]*Math.PI/180),0,1,0,0]; break;
    }
    if (!next || !next.every(Number.isFinite)) throw Error('Unsupported raster image transform');
    matrix = mul(matrix, next);
  }
  if (value.replace(/[a-z]+\s*\([^)]*\)/gi, '').trim()) throw Error('Unsupported raster image transform');
  return matrix;
}
const length = (node, key, fallback=0) => {
  const value = node.getAttribute(key);
  if (!value) return fallback;
  if (!/^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?(?:px)?$/i.test(value)) throw Error('Unsupported raster image viewport units');
  return Number(value.replace(/px$/, ''));
};
function fit(x, y, w, h, vx, vy, vw, vh, aspect) {
  let sx=w/vw, sy=h/vh, dx=0, dy=0;
  if (!/^\s*none\b/.test(aspect)) {
    sx=sy=/\bslice\b/.test(aspect)?Math.max(sx,sy):Math.min(sx,sy);
    dx=(w-vw*sx)*(/xMin/.test(aspect)?0:/xMax/.test(aspect)?1:0.5);
    dy=(h-vh*sy)*(/YMin/.test(aspect)?0:/YMax/.test(aspect)?1:0.5);
  }
  return [sx,0,0,sy,x+dx-vx*sx,y+dy-vy*sy];
}
function property(node, name) {
  for (let n=node; n?.nodeType===1; n=n.parentNode) {
    const v=new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(n.getAttribute('style')??'')?.[1].trim().replace(/\s*!important$/, '') ?? n.getAttribute(name);
    if (v && v!=='inherit') return v;
  }
  return 'auto';
}
function chunk(name, bytes) {
  const b=Buffer.alloc(bytes.length+12); b.writeUInt32BE(bytes.length); b.write(name,4); bytes.copy(b,8); b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4); return b;
}
function png(pixels,w,h) {
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc((w*4+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const i=(y*w+x)*4,j=y*(w*4+1)+1+x*4,a=pixels[i+3];
    for(let c=0;c<3;c++)rows[j+c]=a?Math.min(255,Math.round(pixels[i+c]*255/a)):0;
    rows[j+3]=a;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:3})),chunk('IEND',Buffer.alloc(0))]);
}
function resample(source, sw, sh, dw, dh, nearest) {
  const out=Buffer.alloc(dw*dh*4);
  for(let y=0;y<dh;y++) {
    const fy=Math.max(0,Math.min(sh-1,(y+0.5)*sh/dh-0.5)), y0=Math.floor(fy), y1=Math.min(sh-1,y0+1), ty=fy-y0;
    for(let x=0;x<dw;x++) {
      const to=(y*dw+x)*4;
      if(nearest) { const from=(Math.min(sh-1,Math.floor(y*sh/dh))*sw+Math.min(sw-1,Math.floor(x*sw/dw)))*4;source.copy(out,to,from,from+4);continue; }
      const fx=Math.max(0,Math.min(sw-1,(x+0.5)*sw/dw-0.5)),x0=Math.floor(fx),x1=Math.min(sw-1,x0+1),tx=fx-x0;
      for(let c=0;c<4;c++)out[to+c]=Math.round((source[(y0*sw+x0)*4+c]*(1-tx)+source[(y0*sw+x1)*4+c]*tx)*(1-ty)+(source[(y1*sw+x0)*4+c]*(1-tx)+source[(y1*sw+x1)*4+c]*tx)*ty);
    }
  }
  return out;
}
const cache=new Map();let cacheBytes=0;
export function prepareSceneImages(root) {
  if (!root.getElementsByTagName('image').length) return;
  const matrices=new WeakMap();
  for(const node of [root,...Array.from(root.getElementsByTagName('*'))]) {
    // A placement this preparer cannot compute (units, odd transforms) is null for the
    // whole subtree: those images keep resvg's native rendering, never a refusal (QA-P6a).
    const parent=matrices.has(node.parentNode)?matrices.get(node.parentNode):ID;
    let matrix=null;
    if(parent) try {
      matrix=mul(parent,transform(node.getAttribute('transform')??''));
      if(node.localName==='svg') {
        const vb=nums(node.getAttribute('viewBox')??'');
        const x=length(node,'x'),y=length(node,'y');
        matrix=mul(matrix,vb.length===4?fit(x,y,length(node,'width',vb[2]),length(node,'height',vb[3]),...vb,node.getAttribute('preserveAspectRatio')??''): [1,0,0,1,x,y]);
      }
    } catch { matrix=null; }
    matrices.set(node,matrix);
    if(node.localName!=='image'||!matrix)continue;
    const attr=node.hasAttribute('href')?'href':'xlink:href',url=node.getAttribute(attr)??'';
    const match=/^data:image\/(png|jpe?g|gif);base64,([a-z0-9+/=\s]+)$/i.exec(url);if(!match)continue;
    const bytes=Buffer.from(match[2],'base64'),size=match[1]==='png'?pngInfo(bytes):probeImageSize('image.'+match[1],bytes);
    if(!size)continue; // unreadable or mislabeled bytes: resvg's own decoder decides, as before P6a
    const sw=size.width,sh=size.height;
    if(sw*sh>16_000_000)continue;
    const placement=fit(length(node,'x'),length(node,'y'),length(node,'width',sw),length(node,'height',sh),0,0,sw,sh,node.getAttribute('preserveAspectRatio')??'');
    const total=mul(matrix,placement),w=Math.max(1,Math.ceil(Math.hypot(total[0],total[1])*sw)),h=Math.max(1,Math.ceil(Math.hypot(total[2],total[3])*sh));
    const nearest=/^(pixelated|crisp-edges)$/.test(property(node,'image-rendering'));
    // Four samples per output pixel preserve the bilinear field through resvg's
    // final bicubic transform, including fractional placement and rotation.
    const integral = n => Math.abs(n-Math.round(n)) < 1e-6;
    const aligned = Math.abs(total[1]) < 1e-6 && Math.abs(total[2]) < 1e-6 && [total[4],total[5],sw*total[0],sh*total[3]].every(integral);
    const dw=nearest||aligned?w:Math.min(sw*4,w*4),dh=nearest||aligned?h:Math.min(sh*4,h*4);
    if(dw*dh>16_000_000)continue;
    const key=createHash('sha256').update(bytes).update(`${dw},${dh},${nearest}`).digest('hex');let data=cache.get(key);
    if(!data) {
      const decoded=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}"><image width="${sw}" height="${sh}" image-rendering="optimizeSpeed" href="${url}"/></svg>`,{font:{loadSystemFonts:false}}).render().pixels;
      let source=decoded,iw=sw,ih=sh;
      // Skia's minification uses a mip level before bilinear sampling.
      if(!nearest)while(iw>=w*2 && ih>=h*2 && iw>1 && ih>1) { const nw=Math.ceil(iw/2),nh=Math.ceil(ih/2);source=resample(source,iw,ih,nw,nh,false);iw=nw;ih=nh; }
      data='data:image/png;base64,'+png(resample(source,iw,ih,dw,dh,nearest),dw,dh).toString('base64');
      cache.set(key,data);cacheBytes+=data.length;
      while(cacheBytes>32*1024*1024 || cache.size>64){const first=cache.keys().next().value;cacheBytes-=cache.get(first).length;cache.delete(first);}
    }
    node.setAttribute(attr,data);
    const mode=nearest?'optimizeSpeed':'optimizeQuality';node.setAttribute('image-rendering',mode);
    node.setAttribute('style',(node.getAttribute('style')??'').replace(/(?:^|;)\s*image-rendering\s*:[^;]*/gi,'')+`;image-rendering:${mode}`);
  }
}
