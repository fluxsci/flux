import { maxNTicks, scalarLabels } from "../ticks";
import type { LayoutTicking, LayoutLocator, LayoutFormatter } from "../types.gen";
import { pyFloorDiv, pyFixed, pyExponential, pyGeneral } from "./numberFormat";
export interface TickSet {values:number[];labels:string[];offset:string;minor:number[];minorLabels:string[];reticked:boolean}
export function multipleTicks(lo:number,hi:number,base:number,offset=0):number[] {
  if(hi<lo)[lo,hi]=[hi,lo];
  if(!(base>0))return [];
  const start=Math.ceil((lo-offset)/base-1e-10)*base+offset;
  const n=Math.floor((hi-start+.001*base)/base);
  if(n>10000)return [];
  return Array.from({length:Math.max(0,n+3)},(_,i)=>start+(i-1)*base);
}
export function logLocatorTicks(lo:number,hi:number,o:LayoutLocator,space=9):number[] {
  if(hi<lo)[lo,hi]=[hi,lo];if(!(lo>0))return [];
  const b=o.base??10,log=(v:number)=>b===10?Math.log10(v):b===2?Math.log2(v):Math.log(v)/Math.log(b);
  const emin=Math.ceil(log(lo)),emax=Math.floor(log(hi)),avail=emax-emin+1;
  let requested=typeof o.numticks==="number"?o.numticks:Math.max(2,Math.min(9,space));
  let subs=o.subs??[1];
  if(typeof subs==="string"){
    if(avail>=10||b<3){if(subs==="auto")return [];subs=[1];}
    else subs=Array.from({length:Math.max(0,Math.ceil(b)-(subs==="auto"?2:1))},(_,i)=>i+(subs==="auto"?2:1));
  }
  let stride=Math.floor(avail/(requested+1))+1;
  const nr=Math.ceil(avail/stride);if(nr<=requested)requested=nr;
  let decades:number[]=[];
  if(requested===0){decades=[emin-1,emax+1];stride=decades[1]-decades[0];}
  else if(requested===1){const at=(log(lo)+log(hi))/2,mid=at%1===.5?2*Math.round(at/2):Math.round(at);stride=Math.max(mid-(emin-1),(emax+1)-mid);decades=[mid-stride,mid,mid+stride];}
  else{
    stride=Math.floor((avail-1)/(requested-1));if(stride<avail/requested)stride=Math.floor(avail/requested);
    const olo=Math.max(avail-stride*requested,0),ohi=Math.min(avail-stride*(requested-1),stride);
    let offset=((-emin%stride)+stride)%stride;if(!(offset>=olo&&offset<ohi))offset=olo;
    for(let e=emin+offset-stride;e<emax+stride+1;e+=stride)decades.push(e);
  }
  const major=subs.length===1&&subs[0]===1;
  const out:number[]=[];
  if(major)for(const e of decades)out.push(b**e);
  else if(stride===1||avail<=1)for(let e=emin-1;e<emax+1&&out.length<10000;e++)for(const s of subs)out.push(s*b**e);
  if(subs.length>1&&stride===1&&decades.length-2+out.filter(v=>v>=lo&&v<=hi).length<=1)return maxNTicks(lo,hi,{nbins:9,steps:[1,2,2.5,5,10]});
  return out;
}
export function scalarFormat(values:number[],domain:number[],o:LayoutFormatter):{labels:string[];offset:string} {
  const [lo,hi]=domain.slice().sort((a,b)=>a-b),visible=values.filter(v=>v>=lo&&v<=hi);
  let offset=o.offset??0,oom=0;
  if(o.useOffset&&visible.length>1){
    const low=Math.min(...visible),high=Math.max(...visible);
    if(low!==high&&!(low<=0&&high>=0)){
      const [a,b]=[Math.abs(low),Math.abs(high)].sort((a,b)=>a-b);
      const max=Math.ceil(Math.log10(b));let power=max;
      while(power>max-30&&pyFloorDiv(a,10**power)===pyFloorDiv(b,10**power))power--;
      power++;
      if((b-a)/10**power<=.01){power=max;while(power>max-30&&pyFloorDiv(b,10**power)-pyFloorDiv(a,10**power)<=1)power--;power++;}
      const n=pyFloorDiv(b,10**power);
      if(n>=10**((o.offsetThreshold??4)-1))offset=Math.sign(low)*n*10**power;
    }
  }
  const limits=o.powerlimits??[-5,6];
  if(o.scientific!==false&&visible.length){
    const candidate=offset?Math.floor(Math.log10(hi-lo)):Math.floor(Math.log10(Math.max(...visible.map(Math.abs))||1));
    if(limits[0]===limits[1]&&limits[0]!==0)oom=limits[0];
    else if(candidate<=limits[0]||candidate>=limits[1])oom=candidate;
  }
  const scaled=values.map(v=>(v-offset)/10**oom);
  const fixed=scalarLabels(scaled).map(v=>o.unicodeMinus===false?v.replaceAll("−","-"):v);
  const formatData=(v:number)=>{
    const exp=Math.floor(Math.log10(Math.abs(v))),s=Number((v/10**exp).toFixed(10)),significand=pyGeneral(s,10);
    return exp===0?significand:o.useMathText?(s===1?`10^{${exp}}`:`${significand} \\times 10^{${exp}}`):`${significand}e${exp}`;
  };
  const addition=offset?(offset>0?"+":"")+formatData(offset):"";
  let text=(oom?`1e${oom}`:"")+addition;
  if(o.useMathText&&(oom||offset))text=`$${oom?`\\times\\mathdefault{10^{${oom}}}`:""}\\mathdefault{${addition}}$`;
  if(o.unicodeMinus!==false)text=text.replaceAll("-","−");
  return {labels:o.useMathText?fixed.map(v=>`$\\mathdefault{${v}}$`):fixed,offset:text};
}
function logFormat(value:number,domain:number[],fmt:LayoutFormatter):string {
  if(!value)return '$\\mathdefault{0}$';
  const base=fmt.base??10,log=(v:number)=>Math.log(v)/Math.log(base),fx=log(Math.abs(value)),round=(v:number)=>{const f=Math.floor(v);return v-f===.5?(f%2===0?f:f+1):Math.round(v);},power=round(fx),decade=Math.abs(fx-power)<=1e-9*Math.max(Math.abs(fx),Math.abs(power));
  if(fmt.labelOnlyBase&&!decade)return '';
  const [lo,hi]=domain.slice().sort((a,b)=>a-b),lmin=log(lo),lmax=log(hi),count=Math.floor(lmax)-Math.floor(lmin)+(Number.isInteger(lmin)?1:0),span=Math.abs(lmax-lmin),thresholds=(fmt.minorThresholds??[1,.4]).map(v=>v==='inf'?Infinity:v==='-inf'?-Infinity:Number(v)),coefficient=round(base**(fx-(decade?power:Math.floor(fx))));
  let allowed:Set<number>|null=null;
  if(Number.isFinite(thresholds[0])){
    if(count>thresholds[0])allowed=new Set([1]);
    else if(span>thresholds[1]){const n=Math.floor(base)/2|0;allowed=new Set(Array.from({length:n+1},(_,i)=>round(base**(i/n))));}
    else allowed=new Set(Array.from({length:Math.floor(base)},(_,i)=>i+1));
  }
  if(allowed&&!allowed.has(coefficient))return '';
  const sign=value<0?'-':'',exponent=decade?power:Math.floor(fx);
  if(Math.abs(fx)<(fmt.minExponent??0))return `$\\mathdefault{${sign}${pyGeneral(Math.abs(value),6)}}$`;
  if(decade)return `$\\mathdefault{${sign}${base}^{${power}}}$`;
  let coeff=base**(fx-exponent);if(Math.abs(coeff-round(coeff))<=1e-9*Math.max(Math.abs(coeff),Math.abs(round(coeff))))coeff=round(coeff);
  return `$\\mathdefault{${sign}${pyGeneral(coeff,6)}\\times${base}^{${exponent}}}$`;
}
export function formatLabels(values:number[],domain:number[],fmt:LayoutFormatter):{labels:string[];offset:string} {
  if(fmt.kind==="scalar")return scalarFormat(values,domain,fmt);
  const labels=values.map(v=>{
    if(fmt.kind==="percent"){
      const range=Math.abs(domain[1]-domain[0])/(fmt.xmax??100)*100;
      const decimals=fmt.decimals??Math.max(0,Math.min(5,Math.ceil(2-Math.log10(2*range))));
      const label=pyFixed(v/(fmt.xmax??100)*100,decimals)+(fmt.symbol??"%");
      return fmt.unicodeMinus===false?label:label.replaceAll("-","−");
    }
    if(fmt.kind==="str-method"){
      const match=/\{x:(,)?(?:\.(\d+)([fe])|(g))\}/.exec(fmt.fmt??"");
      if(match){let label=match[4]?pyGeneral(v):match[3]==="e"?pyExponential(v,Number(match[2])):pyFixed(v,Number(match[2]));
        if(match[1])label=label.replace(/\B(?=(\d{3})+(?!\d))/g,",");return fmt.unicodeMinus===false?label:label.replaceAll("-","−");}
    }
    if(fmt.kind==='log-sci')return logFormat(v,domain,fmt);
    return String(v);
  });
  return {labels,offset:""};
}
export function ticksAt(axis:LayoutTicking,len:number,fontPt:number,vertical:boolean):TickSet {
  const space=Math.floor(len/(fontPt*(vertical?2:3))),loc=axis.major;
  const nbins=typeof loc.nbins==="number"?loc.nbins:Math.max(Math.max(1,(loc.minNTicks??2)-1),Math.min(9,space));
  const [lo,hi]=axis.domain;
  const values=!axis.retick?axis.values:loc.kind==="maxn"?maxNTicks(lo,hi,{...loc,nbins,prune:loc.prune as "lower"|"upper"|"both"|null}):
    loc.kind==="multiple"?multipleTicks(lo,hi,loc.base??1,loc.offset):loc.kind==="log"?logLocatorTicks(lo,hi,loc,space):axis.values;
  const formatted=!axis.retick?{labels:axis.labels??values.map(String),offset:axis.offsetText??""}:formatLabels(values,axis.domain,axis.formatter);
  let minor:number[]=[];
  if(axis.minor.kind==='log')minor=logLocatorTicks(lo,hi,axis.minor,space);
  else if(axis.minor.kind==='auto-minor'&&values.length>1){
    const major=[...new Set(values)].sort((a,b)=>a-b),step=major[1]-major[0],mantissa=10**((Math.log10(step)%1+1)%1);
    const n=typeof axis.minor.n==='number'?axis.minor.n:([1,2.5,5,10].some(v=>Math.abs(v-mantissa)<=1e-8+1e-5*Math.abs(v))?5:4),unit=step/n;
    const round=(v:number)=>{const floor=Math.floor(v);return v-floor===.5?(floor%2===0?floor:floor+1):Math.round(v);},first=round((Math.min(lo,hi)-major[0])/unit),last=round((Math.max(lo,hi)-major[0])/unit)+1;
    if(last-first<10000)minor=Array.from({length:Math.max(0,last-first)},(_,i)=>(i+first)*unit+major[0]);
  }
  const transform=(v:number)=>axis.scale==='log'?Math.log(v):v,tolerance=Math.abs(transform(hi)-transform(lo))*1e-5;
  minor=minor.filter(v=>!values.some(m=>Math.abs(transform(v)-transform(m))<=tolerance));
  if(axis.minorRetick===false)minor=axis.minorValues??minor;
  const minorLabels=axis.minorRetick===false?axis.minorLabels??[]:axis.minorFormatter&&axis.minorFormatter.kind!=='fixed'?formatLabels(minor,axis.domain,axis.minorFormatter).labels:minor.map(()=>'');
  return {values,labels:formatted.labels,offset:formatted.offset,minor,minorLabels,reticked:axis.retick};
}
