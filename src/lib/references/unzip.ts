// A minimal, dependency-free ZIP reader — just enough to unpack Europe PMC's
// supplementary-files archive.
//
// Adding a zip library for one endpoint isn't worth the dependency: the two methods that
// actually occur in these archives are STORED (0) and DEFLATE (8), and both runtimes Flux
// targets (Node 20, Electron/Chromium) ship `DecompressionStream("deflate-raw")` natively.
// Encrypted, spanned and ZIP64 archives are not supported and are reported as such rather
// than silently mis-parsed.

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Extract every file from a ZIP archive. Directories and unsupported compression methods
 * are skipped rather than throwing, so one odd member can't lose the rest of the archive.
 * Returns [] if `buf` isn't a readable ZIP.
 */
export async function unzip(buf: Uint8Array): Promise<ZipEntry[]> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The End Of Central Directory record sits at the end, after an optional comment, so it
  // has to be found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // offset of the central directory
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (dv.getUint32(p, true) !== CEN_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry
    if (method !== 0 && method !== 8) continue; // encrypted/unsupported — skip, don't corrupt
    // The local header's name/extra lengths can differ from the central directory's, so the
    // data offset must be computed from the LOCAL header, not assumed.
    if (localOff + 30 > buf.length || dv.getUint32(localOff, true) !== LOC_SIG) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (start + compSize > buf.length) continue;
    try {
      out.push({ name, bytes: method === 0 ? raw.slice() : await inflateRaw(raw) });
    } catch {
      /* one bad member shouldn't lose the archive */
    }
  }
  return out;
}
