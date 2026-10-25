/** CPython float divmod and decimal round-to-even over the exact IEEE value.
 * Normalising a float before toFixed introduces a second rounding at .5 ties. */
export function pyFloorDiv(x:number,y:number):number {
  let rem=x%y,div=(x-rem)/y;
  if(rem&&((y<0)!==(rem<0))){rem+=y;div-=1;}
  let floor=Math.floor(div);if(div-floor>.5)floor++;return floor;
}
const bits=new DataView(new ArrayBuffer(8));
function roundScaled(value:number,power:number):bigint {
  bits.setFloat64(0,Math.abs(value));
  const raw=bits.getBigUint64(0),exp=Number((raw>>52n)&2047n);
  let mantissa=raw&((1n<<52n)-1n);if(exp)mantissa|=1n<<52n;
  const binary=(exp?exp-1023:1-1023)-52;
  let numerator=mantissa,denominator=1n;
  if(binary>=0)numerator<<=BigInt(binary);else denominator<<=BigInt(-binary);
  if(power>=0)numerator*=10n**BigInt(power);else denominator*=10n**BigInt(-power);
  let q=numerator/denominator;const r=numerator%denominator;
  if(r*2n>denominator||(r*2n===denominator&&q%2n===1n))q++;
  return q;
}
export function pyFixed(value:number,digits:number):string {
  digits=Math.max(0,Math.min(100,digits));
  const text=roundScaled(value,digits).toString().padStart(digits+1,"0");
  return (value<0||Object.is(value,-0)?"-":"")+(digits?text.slice(0,-digits)+"."+text.slice(-digits):text);
}
export function pyExponential(value:number,digits:number):string {
  digits=Math.max(0,Math.min(100,digits));let exp=value?Math.floor(Math.log10(Math.abs(value))):0;
  let integer=roundScaled(value,digits-exp);
  if(integer>=10n**BigInt(digits+1)){exp++;integer=roundScaled(value,digits-exp);}
  const text=integer.toString().padStart(digits+1,"0");
  return (value<0||Object.is(value,-0)?"-":"")+text[0]+(digits?"."+text.slice(1):"")+"e"+(exp<0?"-":"+")+Math.abs(exp).toString().padStart(2,"0");
}
export function pyGeneral(value:number,precision=6):string {
  const exp=value?Math.floor(Math.log10(Math.abs(value))):0;
  const trim=(s:string)=>s.includes(".")?s.replace(/0+$/,"").replace(/\.$/,""):s;
  if(exp<-4||exp>=precision){const [m,e]=pyExponential(value,precision-1).split("e");return trim(m)+"e"+e;}
  return trim(pyFixed(value,Math.max(0,precision-1-exp)));
}
