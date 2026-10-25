import type {FluxPlotLayout} from '../types.gen';
import {applyToPoint,transformToAncestor} from '../svgMatrix';
type Font=FluxPlotLayout['fonts'][string];
type Text=FluxPlotLayout['texts'][string];
export function mathPieces(label:string){
 const source=label.replace(/\$|\\mathdefault/g,'').replace(/\\times/g,'×').replaceAll('-','−'),pieces:{text:string;super:boolean}[]=[];let plain='';
 const flush=()=>{if(plain){pieces.push({text:plain,super:false});plain='';}};
 for(let i=0;i<source.length;i++){
  if(source[i]==='^'&&source[i+1]==='{'){flush();const end=source.indexOf('}',i+2);pieces.push({text:source.slice(i+2,end).replaceAll('-','−'),super:true});i=end;}
  else if(source[i]!=='{'&&source[i]!=='}')plain+=source[i];
 }
 flush();return pieces;
}
const advance=(text:string,font:Font)=>[...text].reduce((n,c)=>n+(font.advances[c]??font.advances['0']),0);
export function labelWidth(label:string,font:Font):number {
 if(!label.startsWith('$'))return advance(label,font);
 const match=/^\$\\mathdefault\{(?:(.+)\\times)?(\d+(?:\.\d+)?)\^\{([^}]+)\}\}\$$/.exec(label),math=font.math;
 if(match&&math&&match[2]==='10'){
  const exponent=match[3],digits=exponent.replace(/[−-]/g,'').length;
  const raw=(math.powerRawWidthPt??math.powerWidthPt??0)+(digits-1)*(math.supAdvancePt??advance('0',font)*.7)+(/[−-]/.test(exponent)?math.minusAdvancePt??advance('−',font)*.7:0)+(match[1]?advance(match[1],font)-advance('2',font)+(math.coeffPrefixPt??advance('2×',font)):0);
  return math.quantumPt?Math.ceil(raw/math.quantumPt-1e-10)*math.quantumPt:raw;
 }
 return mathPieces(label).reduce((w,p)=>w+advance(p.text,font)*(p.super?(font.math?.supScale??.7):1),0);
}
/** Rebuild math glyph placement using captured SVG font metrics, never layout reads. */
export function writeMathLabel(wrapper:Element,label:string,native:Text,font:Font):void {
 const old=wrapper.tagName.toLowerCase()==='text'?wrapper:wrapper.querySelector('text');if(!old)return;
 const first=old.querySelector('tspan')??old,x=Number(first.getAttribute('x')??0),y=Number(first.getAttribute('y')??0),baseline=applyToPoint({x,y},transformToAncestor(first,wrapper));
 const text=wrapper.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','text');
 if(old.getAttribute('style'))text.setAttribute('style',old.getAttribute('style')!);
 text.setAttribute('font-family',font.family);text.setAttribute('font-size',String(font.sizePt));(text as SVGElement).style.fontSize=font.sizePt+'px';(text as SVGElement).style.textAnchor='start';
 const alignment=native.ha==='right'?1:native.ha==='center'?.5:0;let cursor=native.anchor[0]-labelWidth(label,font)*alignment;
 const pieces=mathPieces(label),math=font.math;
 const append=(value:string,at:number,raised=false)=>{const span=wrapper.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','tspan');span.textContent=value;span.setAttribute('x',String(at));span.setAttribute('y',String(baseline.y-(raised?(math?.supRisePt??font.sizePt*.413):0)));if(raised){span.setAttribute('font-size',String(font.sizePt*(math?.supScale??.7)));(span as SVGElement).style.fontSize=font.sizePt*(math?.supScale??.7)+'px';}text.appendChild(span);};
 for(const [index,piece]of pieces.entries()){
  if(!piece.super&&pieces[index+1]?.super&&piece.text.includes('×')&&piece.text.endsWith('10')){const coefficient=piece.text.slice(0,piece.text.indexOf('×')),pad=math?.timesPadPt??font.sizePt*.195;append(coefficient,cursor);cursor+=advance(coefficient,font)+pad;append('×',cursor);cursor+=advance('×',font)+pad;append('10',cursor);cursor+=math?.baseAdvance10??advance('10',font);continue;}
  const span=wrapper.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','tspan');span.textContent=piece.text;span.setAttribute('x',String(cursor));span.setAttribute('y',String(baseline.y-(piece.super?(math?.supRisePt??font.sizePt*.413):0)));
  if(piece.super){span.setAttribute('font-size',String(font.sizePt*(math?.supScale??.7)));(span as SVGElement).style.fontSize=font.sizePt*(math?.supScale??.7)+'px';}
  text.appendChild(span);
  let w=advance(piece.text,font)*(piece.super?(math?.supScale??.7):1);
  if(!piece.super&&pieces[index+1]?.super&&piece.text.endsWith('10')){
   if(piece.text==='10')w=math?.baseAdvance10??w;
   else if(piece.text.includes('×'))w=advance(piece.text.slice(0,piece.text.indexOf('×')),font)-advance('2',font)+(math?.coeffPrefixPt??advance('2×',font))+(math?.baseAdvance10??advance('10',font));
  }
  cursor+=w;
 }
 if(native.rotation)text.setAttribute('transform',`rotate(${-native.rotation} ${native.anchor[0]} ${native.anchor[1]})`);
 if(wrapper===old){wrapper.innerHTML=text.innerHTML;}else{wrapper.replaceChildren(text);}
}
