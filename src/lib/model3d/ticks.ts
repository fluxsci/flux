/** Deterministic 1/2/5 ticks; no DOM or text metrics. */
export function niceTicks(min:number,max:number,count=5):number[]{
 if(!Number.isFinite(min)||!Number.isFinite(max)||max<min||!Number.isInteger(count)||count<2||count>100)throw new Error('Invalid tick range/count');
 if(min===max)return [min];
 const raw=(max-min)/(count-1),power=Math.pow(10,Math.floor(Math.log10(raw))),error=raw/power;
 const step=(error>=Math.sqrt(50)?10:error>=Math.sqrt(10)?5:error>=Math.sqrt(2)?2:1)*power;
 const first=Math.ceil(min/step-1e-10),last=Math.floor(max/step+1e-10),out:number[]=[];
 for(let i=first;i<=last&&out.length<1000;i++)out.push(Number((i*step).toPrecision(12))||0);
 return out;
}
export function tickLabel(value:number):string {if(Object.is(value,-0)||value===0)return '0';const abs=Math.abs(value);return abs>=1e5||abs<1e-3?value.toExponential(2).replace(/\.0+(?=e)/,''):String(Number(value.toPrecision(6)));}
