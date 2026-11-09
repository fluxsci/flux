// Small recoverable transaction for source SVG/sidecars + owning compositions.
// The caller holds the project lease. Index remains last; a durable journal makes
// overwritten assets recoverable too. Recovery never overwrites unexpected edits.
export interface TextGenerationIO {
  read(rel: string): Promise<string | null>;
  write(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** Host-specific project confinement, including existing directory symlinks. */
  validatePath?(rel: string): Promise<void>;
  /** Flush renamed/unlinked directory entries before advancing publication. */
  fsyncDir?(rel: string): Promise<void>;
  readBytes?(rel: string): Promise<Uint8Array | null>;
  writeBytes?(rel: string, bytes: Uint8Array): Promise<void>;
}
export type GenerationWrite = string | null | { base64: string };
export function bytesToBase64(bytes: Uint8Array): string {
  let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
}
function fromBase64(value: string): Uint8Array {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
export const TEXT_GENERATION_JOURNAL = '.meta/figure-source-generation.json';
const JOURNAL = TEXT_GENERATION_JOURNAL;
const parent = (rel: string) => { const slash=rel.lastIndexOf('/');return slash<0?'.':rel.slice(0,slash)||'.'; };
interface Entry { path: string; before: string | null; after: string | null; encoding?: 'base64' }
// A journal holds each file's before AND after content. Inline (version 2) that is ONE write whose size is
// twice the write set: two regenerated plots with 34 MB manifests made a 258 MB journal, which the native
// bridge refuses (256 MiB per IPC message), so every open of that project failed its source update
// (2026-11-09). Past TEXT_GENERATION_INLINE_LIMIT the journal (version 3) keeps large content OUT OF LINE,
// one file per value beside it, written and flushed BEFORE the journal that names them; no single write is
// then larger than one file. Small transactions keep the version-2 bytes exactly.
export const TEXT_GENERATION_INLINE_LIMIT = 4 * 1024 * 1024;
export const TEXT_GENERATION_BLOB_MIN = 256 * 1024;
export const textGenerationBlob = (k: number) => `.meta/figure-source-generation.blob.${k}`;
type Stored = string | null | { blob: number };
interface StoredEntry { path: string; before: Stored; after: Stored; encoding?: 'base64' }
const isBlob = (v: unknown): v is { blob: number } => !!v && typeof v === 'object' && Number.isInteger((v as { blob?: unknown }).blob) && (v as { blob: number }).blob >= 0;
/** Remove this journal's out-of-line values and any a crashed transaction left behind (dense from 0). */
async function removeBlobs(io: TextGenerationIO, count: number, assertOwner: () => Promise<void>): Promise<void> {
  let end = count;
  while (await io.read(textGenerationBlob(end)) !== null) end++;
  // Highest first: an interrupted cleanup leaves a dense prefix the next one finds from 0.
  for (let k = end - 1; k >= 0; k--) { await assertOwner(); await io.remove(textGenerationBlob(k)); }
  if (end) await io.fsyncDir?.(parent(JOURNAL));
}
async function readEntry(io: TextGenerationIO, entry: Pick<Entry,'path'|'encoding'>) {
  if(!entry.encoding)return io.read(entry.path);
  if(!io.readBytes)throw Error('Binary figure recovery requires byte reads');
  const bytes=await io.readBytes(entry.path);return bytes===null?null:bytesToBase64(bytes);
}
async function writeEntry(io: TextGenerationIO, entry: Entry, value: string | null) {
  if(value===null)return io.remove(entry.path);
  if(!entry.encoding)return io.write(entry.path,value);
  if(!io.writeBytes)throw Error('Binary figure recovery requires byte writes');
  return io.writeBytes(entry.path,fromBase64(value));
}
function safe(rel: unknown): asserts rel is string {
  if (typeof rel !== 'string' || !rel || /[\\\x00]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..') || (!rel.startsWith('fig/') && !rel.startsWith('slides/') && !rel.endsWith('.json') && rel !== JOURNAL)) throw new Error(`Invalid source recovery path: ${String(rel)}`);
}
export async function recoverTextGeneration(io: TextGenerationIO, assertOwner: () => Promise<void> = async () => {}): Promise<void> {
  await io.validatePath?.(JOURNAL);
  const text = await io.read(JOURNAL);
  // No journal: values a finished or never-journalled transaction left out of line are garbage.
  if (text === null) { await removeBlobs(io, 0, assertOwner); return; }
  const journal = JSON.parse(text);
  if (![1,2,3].includes(journal?.version) || !Array.isArray(journal.files)) throw new Error('Invalid source recovery journal');
  const blobs = journal.version === 3 ? journal.blobs : 0;
  if (!Number.isInteger(blobs) || blobs < 0) throw new Error('Invalid source recovery journal');
  const seen = new Set<string>(), named = new Set<number>();
  const stored = (v: unknown) => v === null || typeof v === 'string' || (journal.version === 3 && isBlob(v) && v.blob < blobs && !named.has(v.blob) && !!named.add(v.blob));
  for (const entry of journal.files) {
    safe(entry?.path);
    if (seen.has(entry.path) || entry.path === JOURNAL || ![entry.before,entry.after].every(stored)) throw new Error('Invalid source recovery entry');
    seen.add(entry.path);
    if(entry.encoding!==undefined&&entry.encoding!=='base64')throw Error('Invalid recovery encoding');
    if(entry.encoding==='base64')for(const value of [entry.before,entry.after])if(typeof value==='string')fromBase64(value);
  }
  // Reject the entire untrusted journal before restoring even a valid sibling.
  for (const entry of journal.files) await io.validatePath?.(entry.path);
  for (let k = 0; k < blobs; k++) await io.validatePath?.(textGenerationBlob(k));
  // An out-of-line value is read when its entry is judged, one at a time.
  const load = async (entry: StoredEntry, side: 'before' | 'after'): Promise<string | null> => {
    const value = entry[side];
    if (value === null || typeof value === 'string') return value;
    const content = await io.read(textGenerationBlob(value.blob));
    if (content === null) throw new Error('recovery content is missing');
    if (entry.encoding === 'base64') fromBase64(content);
    return content;
  };
  const errors: string[] = [];
  for (const entry of [...journal.files].reverse() as StoredEntry[]) {
    try {
      const current = await readEntry(io,entry), before = await load(entry,'before');
      if (current === before) continue;
      if (current !== await load(entry,'after')) { errors.push(`${entry.path}: changed outside transaction`); continue; }
      await assertOwner(); await writeEntry(io,{path:entry.path,before,after:null,encoding:entry.encoding},before);
      await io.fsyncDir?.(parent(entry.path));
    } catch (error) { errors.push(`${entry.path}: ${String(error)}`); }
  }
  if (errors.length) throw new Error(`Source recovery retained at ${JOURNAL}: ${errors.join('; ')}`);
  await assertOwner(); await io.remove(JOURNAL);
  await io.fsyncDir?.(parent(JOURNAL));
  if (journal.version === 3) await removeBlobs(io, blobs, assertOwner);
}
export async function commitTextGeneration(io: TextGenerationIO, writes: ReadonlyMap<string, GenerationWrite>, assertOwner: () => Promise<void> = async () => {}): Promise<void> {
  await io.validatePath?.(JOURNAL);
  for (const rel of writes.keys()) {
    safe(rel);if(rel===JOURNAL)throw new Error('Source recovery journal cannot be a transaction target');
    await io.validatePath?.(rel);
  }
  await recoverTextGeneration(io, assertOwner);
  const files: Entry[] = [];
  for (const [rel, value] of writes) {
    safe(rel); const encoding = value!==null && typeof value==='object' ? 'base64' as const : undefined;
    const after=encoding?(value as {base64:string}).base64:value as string|null;
    if(encoding)fromBase64(after!);
    const before = await readEntry(io,{path:rel,encoding});
    if (before !== after) files.push({path: rel, before, after, ...(encoding?{encoding}:{})});
  }
  if (!files.length) return;
  await assertOwner();
  const inline = files.reduce((n, f) => n + (f.before?.length ?? 0) + (f.after?.length ?? 0), 0);
  let blobs = -1;
  if (inline <= TEXT_GENERATION_INLINE_LIMIT) await io.write(JOURNAL, JSON.stringify({version:2, files}));
  else {
    blobs = 0;
    await removeBlobs(io, 0, assertOwner);
    const stored: StoredEntry[] = [];
    for (const f of files) {
      const out: StoredEntry = {path: f.path, before: f.before, after: f.after, ...(f.encoding?{encoding:f.encoding}:{})};
      for (const side of ['before','after'] as const) {
        const value = f[side];
        if (value === null || value.length <= TEXT_GENERATION_BLOB_MIN) continue;
        await assertOwner(); await io.write(textGenerationBlob(blobs), value);
        out[side] = {blob: blobs++};
      }
      stored.push(out);
    }
    // The values a journal names must be durable before the journal exists.
    await io.fsyncDir?.(parent(JOURNAL));
    await assertOwner();
    await io.write(JOURNAL, JSON.stringify({version:3, blobs, files: stored}));
  }
  // The undo record must survive a crash before any source is overwritten.
  await io.fsyncDir?.(parent(JOURNAL));
  try {
    for (const entry of files) {
      if (await readEntry(io,entry) !== entry.before) throw new Error(`Source generation diverged: ${entry.path}`);
      await assertOwner();
      await writeEntry(io,entry,entry.after);
      // In particular, make canvas/asset renames durable BEFORE the index.
      await io.fsyncDir?.(parent(entry.path));
    }
    await assertOwner(); await io.remove(JOURNAL);
    await io.fsyncDir?.(parent(JOURNAL));
    if (blobs >= 0) await removeBlobs(io, blobs, assertOwner);
  } catch (error) {
    try { await recoverTextGeneration(io, assertOwner); }
    catch (recovery) { throw new AggregateError([error, recovery], 'Source update failed; recovery retained'); }
    throw error;
  }
}
