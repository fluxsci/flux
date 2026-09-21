import type { CssNode, ParseOptions, ListItem, List } from "css-tree";
// Passive scientific SVG policy shared by every import/render host. CSS is
// parsed, never inspected with a regex pretending to be a CSS grammar.
import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';
import { ident } from 'css-tree/utils';
const SVG='http://www.w3.org/2000/svg', XLINK='http://www.w3.org/1999/xlink', XML='http://www.w3.org/XML/1998/namespace';
const tags=new Set(('svg a g defs symbol use switch title desc metadata style path rect circle ellipse line polyline polygon text tspan textPath image clipPath mask pattern linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence marker view').toLowerCase().split(' '));
const paints=new Set(['fill','stroke','filter','clip-path','mask','marker-start','marker-mid','marker-end','cursor']);
const properties=new Set(('fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit opacity color color-interpolation color-interpolation-filters flood-color flood-opacity lighting-color stop-color stop-opacity font font-family font-size font-style font-weight font-stretch font-variant letter-spacing word-spacing text-anchor text-decoration text-rendering dominant-baseline alignment-baseline baseline-shift display visibility overflow clip-path mask filter marker-start marker-mid marker-end vector-effect paint-order shape-rendering image-rendering transform transform-origin transform-box white-space').split(' '));
const functions=new Set(['rgb','rgba','hsl','hsla','hwb','lab','lch','oklab','oklch','color','color-mix','calc','min','max','clamp','matrix','matrix3d','translate','translatex','translatey','translate3d','scale','scalex','scaley','rotate','rotatez','skew','skewx','skewy']);
export function localFragment(value: string) { return /^#[^\s<>"'\\]+$/.test(value.trim()); }
function safeValue(ast: CssNode) {
  let safe=true;
  walk(ast,node=>{
    if(node.type==='Url' && !localFragment(node.value)) safe=false;
    if(node.type==='Raw' || (node.type==='Function' && !functions.has(ident.decode(node.name).toLowerCase()))) safe=false;
    if(node.type==='Identifier' && /^(?:-moz-binding|expression)$/i.test(ident.decode(node.name))) safe=false;
  });return safe;
}
export function passiveCss(css: string, context: ParseOptions['context']='stylesheet') {
  try {
    const ast=parse(css,{context});
    walk(ast,{enter(node: CssNode,item: ListItem<CssNode>,list: List<CssNode>){
      if(node.type==='Atrule' && !['media','supports'].includes(ident.decode(node.name).toLowerCase())) {if(list&&item)list.remove(item);return walk.skip;}
      if(node.type==='Declaration' && (!properties.has(ident.decode(node.property).toLowerCase()) || !safeValue(node.value))) {if(list&&item)list.remove(item);return walk.skip;}
      if(node.type==='Raw') throw Error('Unparsed CSS');
    }});return generate(ast);
  } catch { return ''; }
}
export function passivePaint(value: string) {
  try { return safeValue(parse(String(value),{context:'value',onParseError(error){throw error}})) ? String(value) : 'none'; }
  catch { return 'none'; }
}
export function passiveImageUrl(value: string) {
  const match=/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/=\s]+)$/i.exec(value.trim());
  if(!match)return false;
  try {const bytes=atob(match[2]);const hex=[...bytes.slice(0,12)].map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
    return match[1].toLowerCase()==='png'?hex.startsWith('89504e470d0a1a0a'):match[1].toLowerCase()==='jpeg'?hex.startsWith('ffd8ff'):match[1].toLowerCase()==='gif'?bytes.startsWith('GIF87a')||bytes.startsWith('GIF89a'):bytes.startsWith('RIFF')&&bytes.slice(8,12)==='WEBP';
  }catch{return false;}
}
// linkedom reports XHTML namespaceURI for XML documents, so resolve declarations
// from the parsed tree explicitly; browser and headless obey the same contract.
export function svgNamespace(el: Element,prefix='') {
  if(prefix==='xml')return XML;
  for(let at: Element | null=el;at;at=at.parentElement){const value=at.getAttribute(prefix?`xmlns:${prefix}`:'xmlns');if(value!==null)return value;}
  return prefix?null:SVG; // historical namespace-less scientific SVGs
}
export function sanitizePassiveSvg(root: Element) {
  for(const el of [root,...root.querySelectorAll('*')]) {
    const parts=el.tagName.split(':'), local=parts.at(-1)!.toLowerCase();
    if(svgNamespace(el,parts.length>1?parts[0]:'')!==SVG||!tags.has(local)) {el.remove();continue;}
    for(const attr of [...el.attributes]) {
      const names=attr.name.split(':'), name=names.at(-1)!.toLowerCase(), prefix=names.length>1?names[0]:'';
      if(attr.name==='xmlns'||prefix==='xmlns')continue;
      const ns=prefix?svgNamespace(el,prefix):null;
      if(name.startsWith('on')||['begin','end','tabindex','autofocus'].includes(name)||(prefix&&ns!==XLINK&&ns!==XML)) {el.removeAttribute(attr.name);continue;}
      if(ns===XML&&name!=='space'&&name!=='lang') {el.removeAttribute(attr.name);continue;}
      if(name==='href') {
        const value=attr.value.trim();
        if(!localFragment(value)&&!(local==='image'&&passiveImageUrl(value)))el.removeAttribute(attr.name);
      } else if(name==='style') {const clean=passiveCss(attr.value,'declarationList');if(clean)el.setAttribute(attr.name,clean);else el.removeAttribute(attr.name);}
      else if(paints.has(name)) el.setAttribute(attr.name,passivePaint(attr.value));
      else if(['src','background'].includes(name))el.removeAttribute(attr.name);
    }
    if(local==='style')el.textContent=passiveCss(el.textContent??'');
  }
}
export function rewriteLocalUrls(value: string,map: Map<string,string>) {
  try {const ast=parse(value,{context:'value'});walk(ast,node=>{if(node.type==='Url'&&localFragment(node.value))node.value='#'+(map.get(node.value.trim().slice(1))??node.value.trim().slice(1));});return generate(ast);}catch{return value;}
}
export function rewriteCssReferences(css: string,map: Map<string,string>) {
  try {const ast=parse(css);walk(ast,node=>{if(node.type==='Url'&&localFragment(node.value))node.value='#'+(map.get(node.value.trim().slice(1))??node.value.trim().slice(1));else if(node.type==='IdSelector'){const id=ident.decode(node.name);node.name=ident.encode(map.get(id)??id);}});return generate(ast);}catch{return '';}
}
