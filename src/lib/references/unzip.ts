// Bounded ZIP reader for Europe PMC supplementary archives. It owns ZIP framing
// and CRC validation; callers sanitize names before selecting an output path.
export interface ZipEntry { name: string; bytes: Uint8Array }
export const ZIP_LIMITS = { archive: 80 * 1024 * 1024, entries: 2000, member: 80 * 1024 * 1024, total: 256 * 1024 * 1024 };
const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
const crcTable = Uint32Array.from({length:256}, (_, n) => { let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0; });
async function crc32(bytes: Uint8Array) {
  let c=0xffffffff;
  for(let start=0;start<bytes.length;start+=1024*1024){
    if(start)await new Promise(resolve=>setTimeout(resolve,0));
    for(let i=start,end=Math.min(bytes.length,start+1024*1024);i<end;i++)c=crcTable[(c^bytes[i])&255]^(c>>>8);
  }
  return (c^0xffffffff)>>>0;
}
const invalid = (reason: string): never => { throw new Error(`Invalid supplementary ZIP: ${reason}`); };
async function inflateRaw(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[]=[]; let size=0;
  try {
    for(;;) { const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>limit) {await reader.cancel();invalid('expanded member exceeds resource limit');} chunks.push(value); }
    const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
  } finally {reader.releaseLock();}
}
/** Reject malformed/unsupported members rather than reporting a partial archive as success. */
export async function unzip(buf: Uint8Array): Promise<ZipEntry[]> {
  if(buf.byteLength>ZIP_LIMITS.archive) invalid('archive exceeds resource limit');
  if(buf.byteLength<22) invalid('truncated end record');
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  let end=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-22-0xffff);i--) if(dv.getUint32(i,true)===EOCD && i+22+dv.getUint16(i+20,true)===buf.length){end=i;break;}
  if(end<0)invalid('missing or truncated end record');
  const count=dv.getUint16(end+10,true),size=dv.getUint32(end+12,true),start=dv.getUint32(end+16,true);
  if(dv.getUint16(end+4,true)!==0||dv.getUint16(end+6,true)!==0||dv.getUint16(end+8,true)!==count)invalid('spanned archive');
  if(count===0xffff||size===0xffffffff||start===0xffffffff)invalid('ZIP64 archive');
  if(count>ZIP_LIMITS.entries)invalid('too many members');
  if(start+size!==end)invalid('truncated central directory');
  // Validate every header and advertised allocation before retaining expanded members.
  const records: {name:string;method:number;compSize:number;expanded:number;crc:number;offset:number}[]=[];
  const ranges: [number,number][]=[];let p=start,declaredTotal=0;
  for(let i=0;i<count;i++) {
    if(p+46>end||dv.getUint32(p,true)!==CEN)invalid('truncated member header');
    const flags=dv.getUint16(p+8,true),method=dv.getUint16(p+10,true),crc=dv.getUint32(p+16,true),compSize=dv.getUint32(p+20,true),expanded=dv.getUint32(p+24,true);
    const nameLen=dv.getUint16(p+28,true),extraLen=dv.getUint16(p+30,true),commentLen=dv.getUint16(p+32,true),disk=dv.getUint16(p+34,true),local=dv.getUint32(p+42,true);
    if(flags&(1|64))invalid('encrypted member');if(method!==0&&method!==8)invalid(`unsupported compression method ${method}`);
    if(disk||local===0xffffffff||compSize===0xffffffff||expanded===0xffffffff)invalid('spanned or ZIP64 member');
    if(p+46+nameLen+extraLen+commentLen>end)invalid('truncated member name');
    const name=new TextDecoder().decode(buf.subarray(p+46,p+46+nameLen));p+=46+nameLen+extraLen+commentLen;
    if(!name||name.includes('\0'))invalid('invalid member name');
    declaredTotal+=expanded;
    if(expanded>ZIP_LIMITS.member||declaredTotal>ZIP_LIMITS.total)invalid('expanded resource limit');
    if(local+30>start||dv.getUint32(local,true)!==LOC)invalid('missing local header');
    if(dv.getUint16(local+6,true)!==flags||dv.getUint16(local+8,true)!==method)invalid('inconsistent local header');
    const offset=local+30+dv.getUint16(local+26,true)+dv.getUint16(local+28,true);
    if(offset>start||offset+compSize>start)invalid('truncated member data');
    if(ranges.some(([a,b])=>local<b&&offset+compSize>a))invalid('overlapping members');ranges.push([local,offset+compSize]);
    if(method===0&&compSize!==expanded)invalid('stored member length mismatch');
    records.push({name,method,compSize,expanded,crc,offset});
  }
  if(p!==end)invalid('central directory count mismatch');
  const out:ZipEntry[]=[];let total=0;
  for(const r of records) {
    const raw=buf.subarray(r.offset,r.offset+r.compSize);
    const limit=Math.min(r.expanded,ZIP_LIMITS.member,ZIP_LIMITS.total-total);
    let bytes:Uint8Array;
    try{bytes=r.method===0?raw.slice():await inflateRaw(raw,limit);}catch(error){invalid(`member decompression failed: ${String(error instanceof Error?error.message:error)}`);}
    if(bytes!.length!==r.expanded)invalid('expanded member length mismatch');
    if(await crc32(bytes!)!==r.crc)invalid('member CRC mismatch');
    total+=bytes!.length;if(total>ZIP_LIMITS.total)invalid('aggregate resource limit');
    if(!r.name.endsWith('/'))out.push({name:r.name,bytes:bytes!});
  }
  return out;
}
